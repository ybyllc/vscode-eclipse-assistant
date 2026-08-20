const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  createHeadlessArgs,
  getDefaultWorkspacePath,
  resolveIdeInstallation
} = require('./headless-command');
const { createFlashPlan, runFlashPlan } = require('./flash-runner');
const { createBuildPseudoterminal } = require('./build-terminal');
const { discoverLaunchConfigurations, resolveElfPath, toProjectRelativePath } = require('./launch-model');
const { findProjectRoot, readProjectInfo } = require('./project-model');
const { SidebarProvider } = require('./sidebar-provider');
const { t } = require('./i18n');

const CONFIG_SECTION = 'eclipseBridge';
const LEGACY_CONFIG_SECTION = 'gd32EclipseBridge';
const TASK_TYPE = 'eclipse-cdt';
const ICON_THEMES = ['tools', 'hardware', 'build', 'package'];
let extensionContext;
let flashOutput;
let flashAbortController;

function configurationFor(projectDirectory) {
  return vscode.workspace.getConfiguration(CONFIG_SECTION, vscode.Uri.file(projectDirectory));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function discoverProjectRoots() {
  const roots = new Set();
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activePath));
    const root = await findProjectRoot(activePath, workspaceFolder?.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await findProjectRoot(folder.uri.fsPath, folder.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }

  if (roots.size === 0) {
    const projectFiles = await vscode.workspace.findFiles('**/.project', '**/{.git,node_modules}/**', 50);
    for (const projectFile of projectFiles) {
      const candidate = path.dirname(projectFile.fsPath);
      if (await pathExists(path.join(candidate, '.cproject'))) {
        roots.add(candidate);
      }
    }
  }
  return [...roots];
}

async function selectProjectRoot(explicitDirectory) {
  if (explicitDirectory) {
    return path.resolve(explicitDirectory);
  }
  const roots = await discoverProjectRoots();
  if (roots.length === 0) {
    throw new Error(t('error.noProject'));
  }
  if (roots.length === 1) {
    return roots[0];
  }
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: path.basename(root), description: root, root })),
    { placeHolder: t('pick.project') }
  );
  return picked?.root;
}

function chooseDefaultConfiguration(configurations) {
  return configurations.find((name) => /debug/i.test(name)) ?? configurations[0];
}

async function migrateLegacyConfiguration(root) {
  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION, vscode.Uri.file(root));
  const keys = ['installationPath', 'workspacePath', 'configuration', 'launchConfiguration', 'elfPath', 'autoImport'];
  for (const key of keys) {
    const legacyValue = legacy.get(key);
    if (legacyValue !== undefined && legacyValue !== '' && configurationFor(root).get(key) === undefined) {
      await configurationFor(root).update(key, legacyValue, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
}

async function resolveBuildContext(definition = {}) {
  const projectDirectory = await selectProjectRoot(definition.projectDirectory);
  if (!projectDirectory) {
    return undefined;
  }
  await migrateLegacyConfiguration(projectDirectory);
  const project = await readProjectInfo(projectDirectory);
  const config = configurationFor(projectDirectory);
  const installationPath = config.get('installationPath', '');
  const ide = resolveIdeInstallation(installationPath);
  const executable = ide?.headlessExecutable;
  if (!executable || !(await pathExists(executable))) {
    throw new Error(t('error.ideNotConfigured'));
  }

  const installationDirectory = path.dirname(executable);
  const configuredWorkspace = config.get('workspacePath', '');
  const workspacePath = configuredWorkspace
    ? path.resolve(configuredWorkspace)
    : getDefaultWorkspacePath(extensionContext.globalStorageUri.fsPath, projectDirectory);
  const requestedConfiguration = definition.configuration || config.get('configuration', '');
  const configuration = project.configurations.includes(requestedConfiguration)
    ? requestedConfiguration
    : chooseDefaultConfiguration(project.configurations);
  const metadataDirectory = path.join(
    workspacePath,
    '.metadata',
    '.plugins',
    'org.eclipse.core.resources',
    '.projects',
    project.projectName
  );
  const imported = await pathExists(metadataDirectory);
  const autoImport = config.get('autoImport', true);
  if (!imported && !autoImport) {
    throw new Error(t('error.projectNotImported', project.projectName, workspacePath));
  }

  await fs.mkdir(workspacePath, { recursive: true });
  return {
    ...project,
    executable,
    installationDirectory,
    headlessArguments: ide.headlessArguments,
    workspacePath,
    configuration,
    importProject: !imported && autoImport
  };
}

async function createTask(mode, definition = {}) {
  const context = await resolveBuildContext(definition);
  if (!context) {
    return undefined;
  }
  const taskDefinition = {
    type: TASK_TYPE,
    mode,
    projectDirectory: context.projectDirectory,
    configuration: context.configuration
  };
  const args = createHeadlessArgs({ ...context, mode });
  const execution = new vscode.CustomExecution(async () => createBuildPseudoterminal(vscode, {
    executable: context.executable,
    args,
    cwd: context.installationDirectory,
    projectName: context.projectName,
    configuration: context.configuration,
    buildLabel: t('terminal.build'),
    cleanBuildLabel: mode === 'cleanBuild' ? t('terminal.cleanBuild') : undefined,
    projectLabel: t('terminal.project'),
    configurationLabel: t('terminal.configuration'),
    ideLabel: t('terminal.ide'),
    successLabel: (duration) => t('terminal.success', duration.toFixed(1)),
    failedLabel: (exitCode, duration, detail) => detail
      ? t('terminal.failedWithDetail', exitCode, detail)
      : t('terminal.failed', exitCode, duration.toFixed(1)),
    stoppedLabel: t('terminal.stopped')
  }));
  const task = new vscode.Task(
    taskDefinition,
    vscode.TaskScope.Workspace,
    mode === 'cleanBuild'
      ? `${t('command.cleanBuild')} ${context.projectName} (${context.configuration})`
      : `${t('command.build')} ${context.projectName} (${context.configuration})`,
    'Eclipse CDT',
    execution,
    ['$gcc']
  );
  task.group = mode === 'build'
    ? vscode.TaskGroup.Build
    : vscode.TaskGroup.Clean;
  task.presentationOptions = {
    echo: false,
    reveal: vscode.TaskRevealKind.Always,
    focus: false,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: false,
    clear: true
  };
  return task;
}

async function executeBuild(mode) {
  try {
    const task = await createTask(mode);
    if (task) {
      await vscode.tasks.executeTask(task);
    }
  } catch (error) {
    const action = await vscode.window.showErrorMessage(error.message, t('dialog.configure'));
    if (action === t('dialog.configure')) {
      await vscode.commands.executeCommand('eclipseBridge.selectInstallation');
    }
  }
}

function abortError() {
  const error = new Error(t('info.stopped'));
  error.name = 'AbortError';
  return error;
}

async function executeTaskAndWait(task, signal) {
  let taskExecution;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const endListener = vscode.tasks.onDidEndTaskProcess((event) => {
    if (event.execution === taskExecution && !settled) {
      settled = true;
      resolveCompletion(event.exitCode);
    }
  });
  const onAbort = () => {
    taskExecution?.terminate();
    if (!settled) {
      settled = true;
      rejectCompletion(abortError());
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    taskExecution = await vscode.tasks.executeTask(task);
    if (signal?.aborted) {
      onAbort();
    }
    return await completion;
  } finally {
    endListener.dispose();
    signal?.removeEventListener('abort', onAbort);
  }
}

async function selectInstallation() {
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    const config = configurationFor(root);
    const current = config.get('installationPath', '');
    const history = extensionContext.globalState.get('installationHistory', []);
    const candidates = [...new Set([current, ...history].filter(Boolean))];
    const browse = { label: t('pick.browseIde'), browse: true };
    const selected = await vscode.window.showQuickPick(
      [
        ...candidates.map((value) => ({
          label: path.basename(value),
          description: value,
          value
        })),
        browse
      ],
      { placeHolder: t('pick.ide'), matchOnDescription: true }
    );
    if (!selected) {
      return;
    }

    let installationPath = selected.value;
    if (selected.browse) {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { [t('dialog.executables')]: ['exe'] },
        openLabel: t('dialog.selectIde')
      });
      if (!files?.[0]) {
        return;
      }
      installationPath = files[0].fsPath;
    }
    const ide = resolveIdeInstallation(installationPath);
    if (!ide?.headlessExecutable || !(await pathExists(ide.headlessExecutable))) {
      await vscode.window.showErrorMessage(t('error.commandNotFound', installationPath));
      return;
    }
    installationPath = ide.selectedExecutable;
    await config.update('installationPath', installationPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await extensionContext.globalState.update(
      'installationHistory',
      [installationPath, ...history.filter((value) => value !== installationPath)].slice(0, 8)
    );
    await vscode.window.showInformationMessage(t('info.ideConfigured', installationPath));
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

async function selectConfiguration() {
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    const project = await readProjectInfo(root);
    const current = configurationFor(root).get('configuration', '');
    const selected = await vscode.window.showQuickPick(
      project.configurations.map((name) => ({
        label: name,
        description: name === current ? t('pick.current') : undefined
      })),
      { placeHolder: t('pick.buildConfig') }
    );
    if (!selected) {
      return;
    }
    await configurationFor(root).update('configuration', selected.label, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showInformationMessage(t('info.buildConfiguration', selected.label));
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

async function selectWorkspace() {
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: t('pick.workspaceDedicated'),
          description: t('pick.workspaceDedicatedDesc'),
          mode: 'dedicated'
        },
        {
          label: t('pick.workspaceCustom'),
          description: t('pick.workspaceCustomDesc'),
          mode: 'custom'
        }
      ],
      { placeHolder: t('pick.workspaceMode') }
    );
    if (!choice) {
      return;
    }

    let workspacePath = '';
    if (choice.mode === 'custom') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t('dialog.selectWorkspace')
      });
      if (!selected?.[0]) {
        return;
      }
      workspacePath = selected[0].fsPath;
    }
    await configurationFor(root).update(
      'workspacePath',
      workspacePath,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await vscode.window.showInformationMessage(
      workspacePath
        ? t('info.workspaceCustom', workspacePath)
        : t('info.workspaceDedicated')
    );
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

async function toggleAutoImport() {
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    const config = configurationFor(root);
    const enabled = !config.get('autoImport', true);
    await config.update('autoImport', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showInformationMessage(enabled ? t('info.autoImportOn') : t('info.autoImportOff'));
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

async function setIconTheme(theme) {
  if (!ICON_THEMES.includes(theme)) {
    return;
  }
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(
    'toolbarIcons',
    theme,
    vscode.ConfigurationTarget.Global
  );
  await vscode.commands.executeCommand('setContext', 'eclipseBridge.iconTheme', theme);
  await vscode.window.showInformationMessage(t('info.iconThemeChanged', t(`command.iconTheme.${theme}`)));
}

async function selectIconTheme() {
  const selected = await vscode.window.showQuickPick(
    ICON_THEMES.map((theme) => ({
      label: t(`command.iconTheme.${theme}`),
      theme
    })),
    { placeHolder: t('pick.iconTheme') }
  );
  if (selected) {
    await setIconTheme(selected.theme);
  }
}

async function getSidebarModel(projectDirectory) {
  const root = projectDirectory || (await discoverProjectRoots())[0];
  if (!root) {
    return undefined;
  }
  await migrateLegacyConfiguration(root);
  const project = await readProjectInfo(root);
  const config = configurationFor(root);
  const installationPath = config.get('installationPath', '');
  const requestedConfiguration = config.get('configuration', '');
  const configuration = project.configurations.includes(requestedConfiguration)
    ? requestedConfiguration
    : chooseDefaultConfiguration(project.configurations);
  const launches = await discoverLaunchConfigurations(root, project.projectName, installationPath);
  const requestedLaunch = config.get('launchConfiguration', '');
  const launch = launches.find((item) => item.name === requestedLaunch) || launches[0];
  const configuredWorkspace = config.get('workspacePath', '');
  const workspacePath = configuredWorkspace
    ? path.resolve(configuredWorkspace)
    : getDefaultWorkspacePath(extensionContext.globalStorageUri.fsPath, root);
  const elfPath = launch
    ? resolveElfPath(launch, root, config.get('elfPath', ''))
    : resolveElfPath(undefined, root, config.get('elfPath', ''));
  const configuredFlashFile = config.get('elfPath', '');

  return {
    ...project,
    installationPath,
    configurations: project.configurations,
    configuration,
    launches,
    launchConfiguration: launch?.name || '',
    elfPath,
    flashFileDisplay: configuredFlashFile || (elfPath ? toProjectRelativePath(root, elfPath) : ''),
    debugger: launch?.debugger || '',
    workspacePath,
    workspaceLabel: configuredWorkspace ? workspacePath : t('sidebar.dedicatedWorkspace'),
    autoImport: config.get('autoImport', true)
  };
}

async function updateProjectSetting(key, value) {
  return updateProjectSettings({ [key]: value });
}

async function updateProjectSettings(values) {
  const root = await selectProjectRoot();
  if (root) {
    const config = configurationFor(root);
    for (const [key, value] of Object.entries(values)) {
      await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }
}

async function selectElfFile() {
  const root = await selectProjectRoot();
  if (!root) {
    return;
  }
  const model = await getSidebarModel(root);
  const defaultUri = model?.elfPath ? vscode.Uri.file(path.dirname(model.elfPath)) : vscode.Uri.file(root);
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri,
    filters: { [t('dialog.flashFiles')]: ['elf', 'axf', 'out', 'hex', 'bin'], [t('dialog.allFiles')]: ['*'] },
    openLabel: t('dialog.selectFlashFile')
  });
  if (selected?.[0]) {
    const configuredPath = toProjectRelativePath(root, selected[0].fsPath);
    await configurationFor(root).update('elfPath', configuredPath, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function executeFlash() {
  if (flashAbortController) {
    flashOutput?.appendLine(`\n${t('log.stopping')}`);
    flashAbortController.abort();
    await vscode.window.showInformationMessage(t('info.stopping'));
    return;
  }
  let controller;
  let plan;
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    controller = new AbortController();
    flashAbortController = controller;
    flashOutput.clear();
    flashOutput.show(true);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('progress.buildAndFlash'),
        cancellable: true
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        progress.report({ message: t('progress.building') });
        flashOutput.appendLine(t('log.buildingBeforeFlash'));
        const buildTask = await createTask('build', { projectDirectory: root });
        if (!buildTask) {
          throw new Error(t('error.buildTaskUnavailable'));
        }
        const exitCode = await executeTaskAndWait(buildTask, controller.signal);
        if (exitCode !== 0) {
          throw new Error(t('error.buildBeforeFlashFailed', exitCode ?? t('error.unknownExitCode')));
        }
        flashOutput.appendLine(t('log.buildSucceeded'));
        flashOutput.show(true);

        const model = await getSidebarModel(root);
        const launch = model.launches.find((item) => item.name === model.launchConfiguration);
        plan = createFlashPlan(launch, model.elfPath);
        progress.report({ message: t('progress.flashing', path.basename(plan.elfPath)) });
        await runFlashPlan(plan, (text) => flashOutput.append(text), controller.signal);
      }
    );
    await vscode.window.showInformationMessage(t('info.flashSuccess', path.basename(plan.elfPath)));
  } catch (error) {
    if (error.name === 'AbortError') {
      flashOutput?.appendLine(`\n${t('log.stopped')}`);
      await vscode.window.showInformationMessage(t('info.stopped'));
    } else {
      flashOutput?.appendLine(`\n${t('info.flashFailed', error.message)}`);
      await vscode.window.showErrorMessage(t('info.flashFailed', error.message), t('info.showOutput')).then((action) => {
        if (action === t('info.showOutput')) {
          flashOutput?.show(true);
        }
      });
    }
  } finally {
    if (flashAbortController === controller) {
      flashAbortController = undefined;
    }
  }
}

async function handleSidebarAction(message) {
  switch (message.action) {
    case 'build':
      await executeBuild('build');
      break;
    case 'flash':
      await executeFlash();
      break;
    case 'selectInstallation':
      await selectInstallation();
      break;
    case 'setBuildConfiguration':
      await updateProjectSetting('configuration', message.value);
      break;
    case 'setLaunchConfiguration':
      await updateProjectSettings({ launchConfiguration: message.value, elfPath: '' });
      break;
    case 'selectElf':
      await selectElfFile();
      break;
    case 'selectWorkspace':
      await selectWorkspace();
      break;
    case 'setAutoImport':
      await updateProjectSetting('autoImport', Boolean(message.value));
      break;
    default:
      break;
  }
}

async function updateProjectContext() {
  const projectOpen = (await discoverProjectRoots()).length > 0;
  await vscode.commands.executeCommand('setContext', 'eclipseBridge.projectOpen', projectOpen);
}

async function showProjectInfo() {
  try {
    const context = await resolveBuildContext();
    if (!context) {
      return;
    }
    const importText = context.importProject ? t('info.projectInfoImported') : t('info.projectInfoReady');
    await vscode.window.showInformationMessage(
      `${context.projectName} | ${context.configuration} | ${context.workspacePath} | ${importText}`,
      { modal: true }
    );
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

function activate(context) {
  extensionContext = context;
  flashOutput = vscode.window.createOutputChannel('Eclipse CDT Flash');
  const sidebarProvider = new SidebarProvider(getSidebarModel, handleSidebarAction);
  const taskProvider = vscode.tasks.registerTaskProvider(TASK_TYPE, {
    async provideTasks() {
      try {
        const task = await createTask('build');
        return task ? [task] : [];
      } catch {
        return [];
      }
    },
    async resolveTask(task) {
      try {
        return await createTask(task.definition.mode, task.definition);
      } catch (error) {
        await vscode.window.showErrorMessage(error.message);
        return undefined;
      }
    }
  });

  const iconTheme = vscode.workspace.getConfiguration(CONFIG_SECTION).get('toolbarIcons', 'tools');
  void vscode.commands.executeCommand('setContext', 'eclipseBridge.iconTheme', iconTheme);

  context.subscriptions.push(
    taskProvider,
    flashOutput,
    vscode.window.registerWebviewViewProvider('eclipseBridge.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        void sidebarProvider.refresh();
        if (event.affectsConfiguration(`${CONFIG_SECTION}.toolbarIcons`)) {
          const theme = vscode.workspace.getConfiguration(CONFIG_SECTION).get('toolbarIcons', 'tools');
          void vscode.commands.executeCommand('setContext', 'eclipseBridge.iconTheme', theme);
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateProjectContext();
      void sidebarProvider.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void updateProjectContext();
      void sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand('eclipseBridge.build', () => executeBuild('build')),
    vscode.commands.registerCommand('eclipseBridge.flash', executeFlash),
    vscode.commands.registerCommand('eclipseBridge.cleanBuild', () => executeBuild('cleanBuild')),
    vscode.commands.registerCommand('eclipseBridge.selectConfiguration', selectConfiguration),
    vscode.commands.registerCommand('eclipseBridge.selectInstallation', selectInstallation),
    vscode.commands.registerCommand('eclipseBridge.selectWorkspace', selectWorkspace),
    vscode.commands.registerCommand('eclipseBridge.toggleAutoImport', toggleAutoImport),
    vscode.commands.registerCommand('eclipseBridge.refreshSidebar', () => sidebarProvider.refresh()),
    vscode.commands.registerCommand('eclipseBridge.showProjectInfo', showProjectInfo),
    vscode.commands.registerCommand('eclipseBridge.selectIconTheme', selectIconTheme)
  );
  for (const theme of ICON_THEMES) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`eclipseBridge.build.${theme}`, () => executeBuild('build')),
      vscode.commands.registerCommand(`eclipseBridge.flash.${theme}`, executeFlash)
    );
  }
  void updateProjectContext();
}

function deactivate() {
  extensionContext = undefined;
  flashOutput = undefined;
}

module.exports = {
  activate,
  deactivate
};
