const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  createHeadlessArgs,
  getDefaultWorkspacePath,
  getExecutable
} = require('./headless-command');
const { findProjectRoot, readProjectInfo } = require('./project-model');

const CONFIG_SECTION = 'gd32EclipseBridge';
const TASK_TYPE = 'gd32-eclipse';
let extensionContext;

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
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select GD32 Embedded Builder folder'
  });
  if (!selected?.[0]) {
    return;
  }
  const executable = path.join(selected[0].fsPath, 'GD32EmbeddedBuilderc.exe');
  if (!(await pathExists(executable))) {
    await vscode.window.showErrorMessage(`GD32EmbeddedBuilderc.exe was not found in ${selected[0].fsPath}.`);
    return;
  }
  const root = await selectProjectRoot();
  if (!root) {
    return;
  }
  await configurationFor(root).update('installationPath', selected[0].fsPath, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.window.showInformationMessage('GD32 Embedded Builder installation configured.');
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
    vscode.commands.registerCommand('gd32EclipseBridge.build', () => executeBuild('build')),
    vscode.commands.registerCommand('gd32EclipseBridge.cleanBuild', () => executeBuild('cleanBuild')),
    vscode.commands.registerCommand('gd32EclipseBridge.selectConfiguration', selectConfiguration),
    vscode.commands.registerCommand('gd32EclipseBridge.selectInstallation', selectInstallation),
    vscode.commands.registerCommand('gd32EclipseBridge.showProjectInfo', showProjectInfo)
  );
}

function deactivate() {
  extensionContext = undefined;
}

module.exports = {
  activate,
  deactivate
};
