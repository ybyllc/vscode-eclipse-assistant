const crypto = require('node:crypto');
const path = require('node:path');
const { resolveIdeInstallation } = require('./ide-discovery');

const APPLICATION_ID = 'org.eclipse.cdt.managedbuilder.core.headlessbuild';

function getExecutable(installationPath) {
  return installationPath ? resolveIdeInstallation(installationPath)?.headlessExecutable : undefined;
}

function getDefaultWorkspacePath(storagePath, projectDirectory) {
  const resolvedProject = path.resolve(projectDirectory);
  const projectLabel = path.basename(resolvedProject)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 40) || 'project';
  const projectKey = crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? resolvedProject.toLowerCase() : resolvedProject)
    .digest('hex')
    .slice(0, 16);
  return path.join(storagePath, 'workspaces', `${projectLabel}-${projectKey}`);
}

function createHeadlessArgs(options) {
  const target = options.configuration
    ? `${options.projectName}/${options.configuration}`
    : options.projectName;
  const args = [
    ...(options.headlessArguments || []),
    '--launcher.suppressErrors',
    '-nosplash',
    '-application',
    APPLICATION_ID,
    '-data',
    options.workspacePath
  ];

  if (options.importProject) {
    args.push('-import', options.projectDirectory);
  }

  args.push(options.mode === 'cleanBuild' ? '-cleanBuild' : '-build', target);
  return args;
}

module.exports = {
  APPLICATION_ID,
  createHeadlessArgs,
  getDefaultWorkspacePath,
  getExecutable,
  resolveIdeInstallation
};
