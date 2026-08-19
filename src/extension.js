const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  createHeadlessArgs,
  getDefaultWorkspacePath,
  getExecutable
} = require('./headless-command');
const { createFlashPlan, runFlashPlan } = require('./flash-runner');
const { discoverLaunchConfigurations, resolveElfPath } = require('./launch-model');
const { findProjectRoot, readProjectInfo } = require('./project-model');
const { SidebarProvider } = require('./sidebar-provider');

const CONFIG_SECTION = 'gd32EclipseBridge';
const TASK_TYPE = 'gd32-eclipse';
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
    throw new Error('No folder containing both .project and .cproject was found.');
  }
  if (roots.length === 1) {
    return roots[0];
  }
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: path.basename(root), description: root, root })),
    { placeHolder: 'Select the Eclipse CDT project' }
  );
  return picked?.root;
}

function chooseDefaultConfiguration(configurations) {
  return configurations.find((name) => /debug/i.test(name)) ?? configurations[0];
}

async function resolveBuildContext(definition = {}) {
  const projectDirectory = await selectProjectRoot(definition.projectDirectory);
  if (!projectDirectory) {
    return undefined;
  }
  const project = await readProjectInfo(projectDirectory);
  const config = configurationFor(projectDirectory);
  const installationPath = config.get('installationPath', '');
  const executable = getExecutable(installationPath);
  if (!executable || !(await pathExists(executable))) {
    throw new Error('GD32 Embedded Builder is not configured. Run "GD32 Eclipse: Select Embedded Builder Installation".');
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
    throw new Error(`Project "${project.projectName}" is not imported in ${workspacePath}.`);
  }

  await fs.mkdir(workspacePath, { recursive: true });
  return {
    ...project,
    executable,
    installationDirectory,
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
  const execution = new vscode.ProcessExecution(context.executable, args, {
    cwd: context.installationDirectory
  });
  const task = new vscode.Task(
    taskDefinition,
    vscode.TaskScope.Workspace,
    mode === 'cleanBuild'
      ? `Clean and Build ${context.projectName} (${context.configuration})`
      : `Build ${context.projectName} (${context.configuration})`,
    'GD32 Eclipse',
    execution,
    ['$gcc']
  );
  task.group = mode === 'build'
    ? vscode.TaskGroup.Build
    : vscode.TaskGroup.Clean;
  return task;
}

async function executeBuild(mode) {
  try {
    const task = await createTask(mode);
    if (task) {
      await vscode.tasks.executeTask(task);
    }
  } catch (error) {
    const action = await vscode.window.showErrorMessage(error.message, 'Configure');
    if (action === 'Configure') {
      await vscode.commands.executeCommand('gd32EclipseBridge.selectInstallation');
    }
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
    const browse = { label: 'Browse for GD32EmbeddedBuilder.exe...', browse: true };
    const selected = await vscode.window.showQuickPick(
      [
        ...candidates.map((value) => ({
          label: path.basename(value),
          description: value,
          value
        })),
        browse
      ],
      { placeHolder: 'Select the GD32 Embedded Builder IDE', matchOnDescription: true }
    );
    if (!selected) {
      return;
    }

    let installationPath = selected.value;
    if (selected.browse) {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { Executables: ['exe'] },
        openLabel: 'Select GD32 Embedded Builder'
      });
      if (!files?.[0]) {
        return;
      }
      installationPath = files[0].fsPath;
    }
    const executable = getExecutable(installationPath);
    if (!(await pathExists(executable))) {
      await vscode.window.showErrorMessage(`GD32EmbeddedBuilderc.exe was not found beside ${installationPath}.`);
      return;
    }
    await config.update('installationPath', installationPath, vscode.ConfigurationTarget.WorkspaceFolder);
    await extensionContext.globalState.update(
      'installationHistory',
      [installationPath, ...history.filter((value) => value !== installationPath)].slice(0, 8)
    );
    await vscode.window.showInformationMessage(`GD32 Embedded Builder: ${installationPath}`);
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
        description: name === current ? 'Current' : undefined
      })),
      { placeHolder: 'Select the CDT build configuration' }
    );
    if (!selected) {
      return;
    }
    await configurationFor(root).update('configuration', selected.label, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showInformationMessage(`GD32 build configuration: ${selected.label}`);
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
          label: 'Use dedicated workspace',
          description: 'Recommended; avoids the Eclipse workspace lock',
          mode: 'dedicated'
        },
        {
          label: 'Choose workspace folder...',
          description: 'Use an existing or new Eclipse workspace directory',
          mode: 'custom'
        }
      ],
      { placeHolder: 'Select the Headless Build workspace mode' }
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
        openLabel: 'Select Headless Workspace'
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
        ? `GD32 Headless Workspace: ${workspacePath}`
        : 'GD32 Headless Workspace: dedicated workspace per project'
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
    await vscode.window.showInformationMessage(`GD32 automatic project import: ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    await vscode.window.showErrorMessage(error.message);
  }
}

async function getSidebarModel(projectDirectory) {
  const root = projectDirectory || (await discoverProjectRoots())[0];
  if (!root) {
    return undefined;
  }
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
    : config.get('elfPath', '');

  return {
    ...project,
    installationPath,
    configurations: project.configurations,
    configuration,
    launches,
    launchConfiguration: launch?.name || '',
    elfPath,
    debugger: launch?.debugger || '',
    workspacePath,
    workspaceLabel: configuredWorkspace ? workspacePath : 'Dedicated workspace per project',
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
    filters: { 'ELF files': ['elf'], 'All files': ['*'] },
    openLabel: 'Select ELF File'
  });
  if (selected?.[0]) {
    await configurationFor(root).update('elfPath', selected[0].fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function executeFlash() {
  if (flashAbortController) {
    flashOutput?.appendLine('\n正在停止烧录...');
    flashAbortController.abort();
    await vscode.window.showInformationMessage('正在停止当前GD32烧录任务...');
    return;
  }
  let controller;
  try {
    const root = await selectProjectRoot();
    if (!root) {
      return;
    }
    const model = await getSidebarModel(root);
    const launch = model.launches.find((item) => item.name === model.launchConfiguration);
    const plan = createFlashPlan(launch, model.elfPath);
    controller = new AbortController();
    flashAbortController = controller;
    flashOutput.clear();
    flashOutput.show(true);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在烧录 ${path.basename(plan.elfPath)}`,
        cancellable: true
      },
      (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return runFlashPlan(plan, (text) => flashOutput.append(text), controller.signal);
      }
    );
    await vscode.window.showInformationMessage(`烧录成功，程序已运行：${path.basename(plan.elfPath)}`);
  } catch (error) {
    if (error.name === 'AbortError') {
      flashOutput?.appendLine('\n烧录已停止。');
      await vscode.window.showInformationMessage('GD32烧录已停止。');
    } else {
      flashOutput?.appendLine(`\n烧录失败：${error.message}`);
      await vscode.window.showErrorMessage(`GD32烧录失败：${error.message}`, '查看输出').then((action) => {
        if (action === '查看输出') {
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
  await vscode.commands.executeCommand('setContext', 'gd32EclipseBridge.projectOpen', projectOpen);
}

async function showProjectInfo() {
  try {
    const context = await resolveBuildContext();
    if (!context) {
      return;
    }
    const importText = context.importProject ? 'will be imported on next build' : 'already imported';
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
  flashOutput = vscode.window.createOutputChannel('GD32 Eclipse Flash');
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

  context.subscriptions.push(
    taskProvider,
    flashOutput,
    vscode.window.registerWebviewViewProvider('gd32EclipseBridge.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        void sidebarProvider.refresh();
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
    vscode.commands.registerCommand('gd32EclipseBridge.build', () => executeBuild('build')),
    vscode.commands.registerCommand('gd32EclipseBridge.flash', executeFlash),
    vscode.commands.registerCommand('gd32EclipseBridge.cleanBuild', () => executeBuild('cleanBuild')),
    vscode.commands.registerCommand('gd32EclipseBridge.selectConfiguration', selectConfiguration),
    vscode.commands.registerCommand('gd32EclipseBridge.selectInstallation', selectInstallation),
    vscode.commands.registerCommand('gd32EclipseBridge.selectWorkspace', selectWorkspace),
    vscode.commands.registerCommand('gd32EclipseBridge.toggleAutoImport', toggleAutoImport),
    vscode.commands.registerCommand('gd32EclipseBridge.refreshSidebar', () => sidebarProvider.refresh()),
    vscode.commands.registerCommand('gd32EclipseBridge.showProjectInfo', showProjectInfo)
  );
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
