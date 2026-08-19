const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function attributesByKey(entries) {
  return Object.fromEntries(
    asArray(entries)
      .filter((entry) => typeof entry?.key === 'string')
      .map((entry) => [entry.key, entry.value])
  );
}

function parseLaunchConfiguration(xml, launchPath) {
  const root = parser.parse(xml)?.launchConfiguration;
  if (!root) {
    throw new Error(`Invalid Eclipse launch configuration: ${launchPath}`);
  }
  const strings = attributesByKey(root.stringAttribute);
  const integers = attributesByKey(root.intAttribute);
  const booleans = attributesByKey(root.booleanAttribute);
  const serverKind = strings['com.gigadevice.debug.gdlink.server'] || '';
  const jtagDevice = strings['com.gigadevice.debug.launch.jtagDevice'] || '';

  return {
    name: path.basename(launchPath, path.extname(launchPath)),
    launchPath: path.resolve(launchPath),
    type: root.type || '',
    projectName: strings['org.eclipse.cdt.launch.PROJECT_ATTR'] || '',
    programName: strings['org.eclipse.cdt.launch.PROGRAM_NAME'] || '',
    imageFileName: strings['com.gigadevice.debug.launch.imageFileName'] || '',
    useFileForImage: booleans['com.gigadevice.debug.launch.useFileForImage'] === 'true',
    serverKind,
    debugger: debuggerLabel(jtagDevice, serverKind),
    serverExecutable: /jlink|jgdbserver/i.test(serverKind)
      ? strings['com.gigadevice.debug.jlink.location'] || ''
      : strings['com.gigadevice.debug.openocd.location'] || '',
    serverParameters: strings['com.gigadevice.debug.launch.serverParam'] || '',
    gdbExecutable: strings['org.eclipse.cdt.dsf.gdb.DEBUG_NAME'] || '',
    host: strings['com.gigadevice.debug.launch.ipAddress'] || 'localhost',
    port: Number(integers['com.gigadevice.debug.launch.portNumber'] || 3333),
    remoteCommand: strings['com.gigadevice.debug.launch.remoteCommand'] || 'target remote',
    initCommands: strings['com.gigadevice.debug.launch.initCommands'] || '',
    resetCommands: strings['com.gigadevice.debug.launch.resetCommands.inrun'] || '',
    runCommands: strings['com.gigadevice.debug.launch.runCommands.inrun'] || '',
    loadImage: booleans['com.gigadevice.debug.launch.loadImage'] !== 'false'
  };
}

function debuggerLabel(jtagDevice, serverKind) {
  const probe = jtagDevice || (/jlink|jgdbserver/i.test(serverKind) ? 'J-Link' : 'GD-Link');
  const server = /jlink|jgdbserver/i.test(serverKind)
    ? 'J-Link GDB Server'
    : /openocd/i.test(serverKind)
      ? 'OpenOCD'
      : serverKind || 'Unknown server';
  return `${probe} / ${server}`;
}

function installationDirectory(installationPath) {
  if (!installationPath) {
    return undefined;
  }
  const resolved = path.resolve(installationPath);
  return path.extname(resolved).toLowerCase() === '.exe' ? path.dirname(resolved) : resolved;
}

async function launchFilesIn(directory) {
  if (!directory) {
    return [];
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.launch')
    .map((entry) => path.join(directory, entry.name));
}

async function discoverLaunchConfigurations(projectDirectory, projectName, installationPath) {
  const installDirectory = installationDirectory(installationPath);
  const launchDirectory = installDirectory && path.join(
    installDirectory,
    'workspace',
    '.metadata',
    '.plugins',
    'org.eclipse.debug.core',
    '.launches'
  );
  const files = [
    ...(await launchFilesIn(projectDirectory)),
    ...(await launchFilesIn(launchDirectory))
  ];
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))];
  const launches = [];
  for (const file of uniqueFiles) {
    try {
      const launch = parseLaunchConfiguration(await fs.readFile(file, 'utf8'), file);
      if (launch.projectName === projectName && launch.type === 'com.gigadevice.debug.gdlink.launchConfigurationType') {
        launches.push(launch);
      }
    } catch {
      // Ignore unrelated or malformed launch files while discovering usable GD32 configurations.
    }
  }
  return launches.sort((left, right) => left.name.localeCompare(right.name));
}

function resolveElfPath(launch, projectDirectory, overridePath) {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  const configuredPath = launch?.useFileForImage && launch.imageFileName
    ? launch.imageFileName
    : launch?.programName;
  if (!configuredPath) {
    return '';
  }
  const workspacePrefix = `\${workspace_loc:/${launch.projectName}}`;
  const expanded = configuredPath.startsWith(workspacePrefix)
    ? path.join(projectDirectory, configuredPath.slice(workspacePrefix.length).replace(/^[/\\]+/, ''))
    : configuredPath;
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(projectDirectory, expanded);
}

module.exports = {
  discoverLaunchConfigurations,
  parseLaunchConfiguration,
  resolveElfPath
};
