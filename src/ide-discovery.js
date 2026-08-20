const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOL_NAMES = new Set([
  'arm-none-eabi-gdb.exe',
  'jlink.exe',
  'jlinkgdbservercl.exe',
  'openocd.exe'
]);
const installationCache = new Map();

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function findFiles(rootDirectory, accept, maxDepth = 6) {
  const matches = [];
  const pending = [{ directory: rootDirectory, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isFile() && accept(entry.name, entryPath)) {
        matches.push(entryPath);
      } else if (entry.isDirectory() && current.depth < maxDepth && !/^(\.metadata|node_modules|p2)$/i.test(entry.name)) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return matches;
}

function decodeEclipsePreference(value) {
  return value
    .replace(/\\:/g, ':')
    .replace(/\\\\/g, '\\')
    .trim();
}

function readRecentWorkspaces(ideRoot) {
  const prefsPath = path.join(ideRoot, 'configuration', '.settings', 'org.eclipse.ui.ide.prefs');
  let contents;
  try {
    contents = fs.readFileSync(prefsPath, 'utf8');
  } catch {
    return [];
  }
  const line = contents.split(/\r?\n/).find((value) => value.startsWith('RECENT_WORKSPACES='));
  if (!line) {
    return [];
  }
  return line.slice('RECENT_WORKSPACES='.length)
    .split(/(?<!\\),/)
    .map(decodeEclipsePreference)
    .filter(isDirectory);
}

function findHeadlessExecutable(ideRoot, selectedExecutable) {
  const selectedName = path.basename(selectedExecutable, '.exe');
  const directCandidates = [
    path.join(ideRoot, `${selectedName}c.exe`),
    path.join(ideRoot, 'eclipsec.exe')
  ];
  const direct = directCandidates.find(isFile);
  if (direct) {
    return direct;
  }
  return findFiles(
    ideRoot,
    (name) => name.toLowerCase() === 'eclipsec.exe' || name.toLowerCase() === `${selectedName.toLowerCase()}c.exe`,
    2
  )[0];
}

function resolveSelectedExecutable(selectedPath) {
  const resolved = path.resolve(selectedPath);
  if (isFile(resolved) && path.extname(resolved).toLowerCase() === '.exe') {
    if (/c\.exe$/i.test(path.basename(resolved))) {
      const guiExecutable = path.join(
        path.dirname(resolved),
        `${path.basename(resolved, '.exe').slice(0, -1)}.exe`
      );
      return isFile(guiExecutable) ? guiExecutable : resolved;
    }
    return resolved;
  }
  if (!isDirectory(resolved)) {
    if (path.extname(resolved).toLowerCase() === '.exe' && isDirectory(path.dirname(resolved))) {
      const siblingHeadless = findHeadlessExecutable(path.dirname(resolved), resolved);
      return siblingHeadless;
    }
    return undefined;
  }
  const executables = findFiles(
    resolved,
    (name) => /\.exe$/i.test(name) && !/c\.exe$/i.test(name) && !/^eclipsec\.exe$/i.test(name),
    2
  );
  return executables.find((file) => /(?:embeddedbuilder|flagchip|eclipse)\.exe$/i.test(file))
    || executables[0]
    || findFiles(resolved, (name) => name.toLowerCase() === 'eclipsec.exe', 2)[0];
}

function resolveIdeInstallation(selectedPath) {
  const cacheKey = path.resolve(selectedPath).toLowerCase();
  if (installationCache.has(cacheKey)) {
    return installationCache.get(cacheKey);
  }
  const selectedExecutable = resolveSelectedExecutable(selectedPath);
  if (!selectedExecutable) {
    return undefined;
  }
  const rootDirectory = path.dirname(selectedExecutable);
  const selectedIsHeadless = /c\.exe$/i.test(path.basename(selectedExecutable));
  const headlessExecutable = selectedIsHeadless
    ? selectedExecutable
    : findHeadlessExecutable(rootDirectory, selectedExecutable);
  const selectedIni = path.join(rootDirectory, `${path.basename(selectedExecutable, '.exe')}.ini`);
  const headlessArguments = path.basename(headlessExecutable || '').toLowerCase() === 'eclipsec.exe' && isFile(selectedIni)
    ? ['--launcher.ini', selectedIni]
    : [];
  const workspaceCandidates = [
    ...readRecentWorkspaces(rootDirectory),
    path.join(rootDirectory, 'workspace'),
    path.join(os.homedir(), 'eclipse-workspace'),
    path.join(os.homedir(), 'workspace')
  ].filter((value, index, values) => isDirectory(value) && values.indexOf(value) === index);
  const discoveredTools = findFiles(rootDirectory, (name) => TOOL_NAMES.has(name.toLowerCase()));
  const tools = Object.fromEntries(
    discoveredTools
      .filter((file) => path.basename(file).toLowerCase() !== 'jlink.exe')
      .sort((left, right) => right.length - left.length)
      .map((file) => [path.basename(file).toLowerCase(), file])
  );
  const jlinkServer = tools['jlinkgdbservercl.exe'];
  const seggerJLink = jlinkServer && path.join(path.dirname(jlinkServer), 'JLink.exe');
  if (seggerJLink && isFile(seggerJLink)) {
    tools['jlink.exe'] = seggerJLink;
  }
  const result = {
    selectedExecutable,
    rootDirectory,
    headlessExecutable,
    headlessArguments,
    workspaceCandidates,
    tools
  };
  installationCache.set(cacheKey, result);
  return result;
}

module.exports = {
  readRecentWorkspaces,
  resolveIdeInstallation
};
