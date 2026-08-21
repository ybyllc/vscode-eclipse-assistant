const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { resolveIdeInstallation } = require('./ide-discovery');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true
});
const SUPPORTED_LAUNCH_TYPES = new Set([
  'com.gigadevice.debug.gdlink.launchConfigurationType',
  'ilg.gnumcueclipse.debug.gdbjtag.jlink.launchConfigurationType',
  'ilg.gnumcueclipse.debug.gdbjtag.openocd.launchConfigurationType'
]);

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

function joinCommands(...values) {
  return values.filter(Boolean).join('\n');
}

function fcLaunchFields(type, strings, integers, booleans) {
  const isJLink = type === 'ilg.gnumcueclipse.debug.gdbjtag.jlink.launchConfigurationType';
  const prefix = isJLink
    ? 'ilg.gnumcueclipse.debug.gdbjtag.jlink'
    : 'ilg.gnumcueclipse.debug.gdbjtag.openocd';
  const port = Number(
    integers[`${prefix}.gdbServerGdbPortNumber`]
    || integers['org.eclipse.cdt.debug.gdbjtag.core.portNumber']
    || (isJLink ? 2331 : 3333)
  );
  const interfaceName = strings[`${prefix}.gdbServerDebugInterface`] || 'swd';
  const speed = strings[`${prefix}.gdbServerDeviceSpeed`] || 'auto';
  const otherArguments = strings[`${prefix}.gdbServerOther`] || '';
  const serverParameters = isJLink
    ? [
      otherArguments,
      `-port ${port}`,
      `-device "${strings[`${prefix}.gdbServerDeviceName`] || ''}"`,
      `-endian ${strings[`${prefix}.gdbServerDeviceEndianness`] || 'little'}`,
      `-speed ${speed}`,
      `-if ${interfaceName}`
    ].filter((value) => !/-device\s+""/.test(value)).join(' ')
    : otherArguments;

  return {
    imageFileName: strings['org.eclipse.cdt.debug.gdbjtag.core.imageFileName'] || '',
    useFileForImage: booleans['org.eclipse.cdt.debug.gdbjtag.core.useFileForImage'] === 'true',
    serverKind: isJLink ? 'J-Link' : 'OpenOCD',
    serverExecutable: strings[`${prefix}.gdbServerExecutable`] || '',
    serverParameters,
    host: strings['org.eclipse.cdt.debug.gdbjtag.core.ipAddress'] || 'localhost',
    port,
    initCommands: joinCommands(
      strings[`${prefix}.gdbClientOtherCommands`],
      strings[`${prefix}.otherInitCommands`]
    ),
    runCommands: strings[`${prefix}.otherRunCommands`] || '',
    loadImage: booleans['org.eclipse.cdt.debug.gdbjtag.core.loadImage'] !== 'false',
    interface: interfaceName,
    speed
  };
}

function parseLaunchConfiguration(xml, launchPath) {
  const root = parser.parse(xml)?.launchConfiguration;
  if (!root) {
    throw new Error(`Invalid Eclipse launch configuration: ${launchPath}`);
  }
  const strings = attributesByKey(root.stringAttribute);
  const integers = attributesByKey(root.intAttribute);
  const booleans = attributesByKey(root.booleanAttribute);
  const type = root.type || '';
  const isFlagchip = /^ilg\.gnumcueclipse\.debug\.gdbjtag\.(?:jlink|openocd)\./.test(type);
  const fcFields = isFlagchip ? fcLaunchFields(type, strings, integers, booleans) : {};
  const serverKind = fcFields.serverKind || strings['com.gigadevice.debug.gdlink.server'] || '';
  const jtagDevice = strings['com.gigadevice.debug.launch.jtagDevice']
    || strings['org.eclipse.cdt.debug.gdbjtag.core.jtagDevice']
    || '';

  return {
    name: path.basename(launchPath, path.extname(launchPath)),
    launchPath: path.resolve(launchPath),
    type,
    projectName: strings['org.eclipse.cdt.launch.PROJECT_ATTR'] || '',
    programName: strings['org.eclipse.cdt.launch.PROGRAM_NAME'] || '',
    imageFileName: fcFields.imageFileName || strings['com.gigadevice.debug.launch.imageFileName'] || '',
    useFileForImage: fcFields.useFileForImage ?? booleans['com.gigadevice.debug.launch.useFileForImage'] === 'true',
    serverKind,
    debugger: debuggerLabel(jtagDevice, serverKind),
    serverExecutable: fcFields.serverExecutable || (/j-?link|jgdbserver/i.test(serverKind)
      ? strings['com.gigadevice.debug.jlink.location'] || ''
      : strings['com.gigadevice.debug.openocd.location'] || ''),
    serverParameters: fcFields.serverParameters || strings['com.gigadevice.debug.launch.serverParam'] || '',
    gdbExecutable: strings['org.eclipse.cdt.dsf.gdb.DEBUG_NAME'] || '',
    host: fcFields.host || strings['com.gigadevice.debug.launch.ipAddress'] || 'localhost',
    port: fcFields.port || Number(integers['com.gigadevice.debug.launch.portNumber'] || 3333),
    remoteCommand: strings['com.gigadevice.debug.launch.remoteCommand'] || 'target remote',
    initCommands: fcFields.initCommands || strings['com.gigadevice.debug.launch.initCommands'] || '',
    resetCommands: strings['com.gigadevice.debug.launch.resetCommands.inrun'] || '',
    runCommands: fcFields.runCommands || strings['com.gigadevice.debug.launch.runCommands.inrun'] || '',
    loadImage: fcFields.loadImage ?? booleans['com.gigadevice.debug.launch.loadImage'] !== 'false',
    interface: fcFields.interface || '',
    speed: fcFields.speed || ''
  };
}

function debuggerLabel(jtagDevice, serverKind) {
  const probe = jtagDevice || (/j-?link|jgdbserver/i.test(serverKind) ? 'J-Link' : 'GD-Link');
  const server = /j-?link|jgdbserver/i.test(serverKind)
    ? 'J-Link GDB Server'
    : /openocd/i.test(serverKind)
      ? 'OpenOCD'
      : serverKind || 'Unknown server';
  return `${probe} / ${server}`;
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
  const ide = installationPath ? resolveIdeInstallation(installationPath) : undefined;
  const launchDirectories = (ide?.workspaceCandidates || []).map((workspace) => path.join(
    workspace, '.metadata', '.plugins', 'org.eclipse.debug.core', '.launches'
  ));
  const files = [
    ...(await launchFilesIn(projectDirectory)),
    ...(await Promise.all(launchDirectories.map(launchFilesIn))).flat()
  ];
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))];
  const launches = [];
  for (const file of uniqueFiles) {
    try {
      const launch = parseLaunchConfiguration(await fs.readFile(file, 'utf8'), file);
      if (launch.projectName === projectName && SUPPORTED_LAUNCH_TYPES.has(launch.type)) {
        launch.serverParameters = expandIdeVariables(launch.serverParameters, ide);
        if (/j-?link/i.test(launch.serverKind) && !/-JLinkDevicesXMLPath\b/i.test(launch.serverParameters)) {
          const devicesXml = ide && path.join(ide.rootDirectory, 'JLinkDevices', 'JLinkDevices.xml');
          if (devicesXml && await fs.access(devicesXml).then(() => true).catch(() => false)) {
            launch.serverParameters += ` -JLinkDevicesXMLPath "${devicesXml}"`;
          }
        }
        if (!launch.serverExecutable || !(await fs.access(launch.serverExecutable).then(() => true).catch(() => false))) {
          launch.serverExecutable = /j-?link|jgdbserver/i.test(launch.serverKind)
            ? ide?.tools['jlinkgdbservercl.exe'] || ''
            : ide?.tools['openocd.exe'] || '';
        }
        if (!launch.gdbExecutable || !(await fs.access(launch.gdbExecutable).then(() => true).catch(() => false))) {
          launch.gdbExecutable = ide?.tools['arm-none-eabi-gdb.exe'] || '';
        }
        launches.push(launch);
      }
    } catch {
      // Ignore unrelated or malformed launch files while discovering supported vendor configurations.
    }
  }
  return launches.sort((left, right) => left.name.localeCompare(right.name));
}

function expandIdeVariables(value, ide) {
  if (!value || !ide?.rootDirectory) {
    return value || '';
  }
  const eclipseHome = `${ide.rootDirectory}${path.sep}`;
  return value.replaceAll('${eclipse_home}', eclipseHome);
}

function resolveWorkspaceLocation(value, projectDirectory, projectName) {
  const match = /^\$\{workspace_loc:([^}]*)\}(.*)$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const resourceParts = `${match[1]}/${match[2]}`
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  if (!projectName || resourceParts.shift()?.toLowerCase() !== projectName.toLowerCase()) {
    return '';
  }
  const projectRoot = path.resolve(projectDirectory);
  const resolved = path.resolve(projectRoot, ...resourceParts);
  const relative = path.relative(projectRoot, resolved);
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? '' : resolved;
}

function resolveElfPath(launch, projectDirectory, overridePath) {
  const configuredPath = overridePath || (launch?.useFileForImage && launch.imageFileName
    ? launch.imageFileName
    : launch?.programName);
  if (!configuredPath) {
    return '';
  }
  const workspaceLocation = resolveWorkspaceLocation(
    configuredPath,
    projectDirectory,
    launch?.projectName
  );
  if (workspaceLocation !== undefined) {
    return workspaceLocation;
  }
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(projectDirectory, configuredPath);
}

function toProjectRelativePath(projectDirectory, filePath) {
  const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return path.resolve(filePath);
  }
  return relativePath.split(path.sep).join('/');
}

module.exports = {
  discoverLaunchConfigurations,
  parseLaunchConfiguration,
  resolveElfPath,
  resolveWorkspaceLocation,
  toProjectRelativePath
};
