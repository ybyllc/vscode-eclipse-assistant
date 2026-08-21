const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createHeadlessArgs,
  getDefaultWorkspacePath,
  getExecutable,
  resolveIdeInstallation
} = require('../src/headless-command');
const { findProjectRoot, readProjectInfo } = require('../src/project-model');
const {
  createFlashPlan,
  createJLinkCommanderScript,
  downloadOutputFailed,
  serverOutputState,
  splitCommandLine
} = require('../src/flash-runner');
const {
  discoverLaunchConfigurations,
  parseLaunchConfiguration,
  resolveElfPath,
  resolveWorkspaceLocation,
  toProjectRelativePath
} = require('../src/launch-model');

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gd32-eclipse-bridge-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, '.project'), `<?xml version="1.0"?>
<projectDescription><name>demo</name></projectDescription>`);
  await fs.writeFile(path.join(root, '.cproject'), `<?xml version="1.0"?>
<cproject>
  <storageModule moduleId="org.eclipse.cdt.core.settings">
    <cconfiguration id="debug">
      <storageModule moduleId="org.eclipse.cdt.core.settings" name="GD ARM MCU Debug" />
    </cconfiguration>
    <cconfiguration id="release">
      <storageModule moduleId="org.eclipse.cdt.core.settings" name="GD ARM MCU Release" />
    </cconfiguration>
  </storageModule>
</cproject>`);
  return root;
}

test('reads project name and managed build configurations', async (context) => {
  const root = await createFixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await readProjectInfo(root);
  assert.equal(project.projectName, 'demo');
  assert.deepEqual(project.configurations, ['GD ARM MCU Debug', 'GD ARM MCU Release']);
});

test('finds the project root from a nested source file', async (context) => {
  const root = await createFixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'src', 'main.c');
  await fs.writeFile(source, 'int main(void) { return 0; }');
  assert.equal(await findProjectRoot(source, root), root);
});

test('builds a safe headless command argument list', () => {
  const args = createHeadlessArgs({
    workspacePath: 'D:\\work space',
    projectDirectory: 'E:\\project source',
    projectName: 'demo',
    configuration: 'GD ARM MCU Debug',
    importProject: true,
    mode: 'cleanBuild'
  });
  assert.deepEqual(args.slice(-4), ['-import', 'E:\\project source', '-cleanBuild', 'demo/GD ARM MCU Debug']);
  assert.equal(args.includes('-import'), true);
  assert.equal(args.includes('D:\\work space'), true);
});

test('prepends IDE-specific launcher arguments to the headless build', () => {
  const args = createHeadlessArgs({
    headlessArguments: ['--launcher.ini', 'D:\\Flagchip IDE\\Flagchip_FC_IDE.ini'],
    workspacePath: 'D:\\workspace',
    projectName: 'demo',
    configuration: 'Debug',
    importProject: false,
    mode: 'build'
  });
  assert.deepEqual(args.slice(0, 2), ['--launcher.ini', 'D:\\Flagchip IDE\\Flagchip_FC_IDE.ini']);
  assert.equal(args.includes('org.eclipse.cdt.managedbuilder.core.headlessbuild'), true);
});

test('accepts either an installation folder or executable path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eclipse-ide-'));
  const executable = path.join(directory, 'eclipsec.exe');
  await fs.writeFile(executable, '');
  try {
    assert.equal(getExecutable(directory), path.resolve(executable));
    assert.equal(getExecutable(executable), path.resolve(executable));
    assert.equal(getExecutable(path.join(directory, 'eclipse.exe')), path.resolve(executable));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('discovers vendor headless launchers from the selected IDE executable', async () => {
  const gdDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gd32-ide-'));
  const gdGui = path.join(gdDirectory, 'GD32EmbeddedBuilder.exe');
  const gdCli = path.join(gdDirectory, 'GD32EmbeddedBuilderc.exe');
  const fcDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flagchip-ide-'));
  const fcGui = path.join(fcDirectory, 'Flagchip_FC_IDE.exe');
  const fcCli = path.join(fcDirectory, 'eclipsec.exe');
  const fcIni = path.join(fcDirectory, 'Flagchip_FC_IDE.ini');
  await Promise.all([
    fs.writeFile(gdGui, ''),
    fs.writeFile(gdCli, ''),
    fs.writeFile(fcGui, ''),
    fs.writeFile(fcCli, ''),
    fs.writeFile(fcIni, '')
  ]);
  try {
    const gd = resolveIdeInstallation(gdGui);
    assert.equal(gd.selectedExecutable, path.resolve(gdGui));
    assert.equal(gd.headlessExecutable, path.resolve(gdCli));
    assert.deepEqual(gd.headlessArguments, []);

    const fc = resolveIdeInstallation(fcGui);
    assert.equal(fc.headlessExecutable, path.resolve(fcCli));
    assert.deepEqual(fc.headlessArguments, ['--launcher.ini', path.resolve(fcIni)]);
  } finally {
    await Promise.all([
      fs.rm(gdDirectory, { recursive: true, force: true }),
      fs.rm(fcDirectory, { recursive: true, force: true })
    ]);
  }
});

test('creates a stable and project-specific headless workspace path', () => {
  const first = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\demo');
  const repeated = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\demo');
  const second = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\other');
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.equal(first.startsWith(path.resolve('D:\\extension-data', 'workspaces')), true);
});

test('reads GD32 debugger and ELF fields from an Eclipse launch configuration', () => {
  const launch = parseLaunchConfiguration(`<?xml version="1.0"?>
<launchConfiguration type="com.gigadevice.debug.gdlink.launchConfigurationType">
  <stringAttribute key="com.gigadevice.debug.gdlink.server" value="JGDBServer"/>
  <stringAttribute key="com.gigadevice.debug.launch.jtagDevice" value="J-Link"/>
  <stringAttribute key="com.gigadevice.debug.jlink.location" value="D:\\Tools\\JLinkGDBServerCL.exe"/>
  <stringAttribute key="com.gigadevice.debug.launch.serverParam" value="-port 2331 -device GD32L235KBQ6 -if swd"/>
  <stringAttribute key="org.eclipse.cdt.dsf.gdb.DEBUG_NAME" value="D:\\Tools\\arm-none-eabi-gdb.exe"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="GD ARM MCU Debug\\demo.elf"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="demo"/>
  <intAttribute key="com.gigadevice.debug.launch.portNumber" value="2331"/>
  <booleanAttribute key="com.gigadevice.debug.launch.loadImage" value="true"/>
</launchConfiguration>`, 'D:\\workspace\\demo.launch');
  assert.equal(launch.debugger, 'J-Link / J-Link GDB Server');
  assert.equal(launch.port, 2331);
  assert.equal(resolveElfPath(launch, 'E:\\projects\\demo'), path.resolve('E:\\projects\\demo', 'GD ARM MCU Debug\\demo.elf'));
});

test('reads Flagchip J-Link fields from an Eclipse launch configuration', () => {
  const launch = parseLaunchConfiguration(`<?xml version="1.0"?>
<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.jlink.launchConfigurationType">
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDeviceName" value="FC4150F512BSxXxxxT1A"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDeviceSpeed" value="4000"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDebugInterface" value="swd"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDeviceEndianness" value="little"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerExecutable" value="\${jlink_path}/\${jlink_gdbserver}"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerOther" value="-JLinkDevicesXMLPath &quot;\${eclipse_home}JLinkDevices/JLinkDevices.xml&quot;"/>
  <intAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerGdbPortNumber" value="2331"/>
  <stringAttribute key="org.eclipse.cdt.debug.gdbjtag.core.jtagDevice" value="GNU MCU J-Link"/>
  <booleanAttribute key="org.eclipse.cdt.debug.gdbjtag.core.loadImage" value="true"/>
  <stringAttribute key="org.eclipse.cdt.dsf.gdb.DEBUG_NAME" value="\${cross_prefix}gdb\${cross_suffix}"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="Debug_FLASH\\FC_Linhai_LCD.elf"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="FC_Linhai_LCD"/>
</launchConfiguration>`, 'C:\\workspace\\fc-jlink.launch');
  const plan = createFlashPlan({
    ...launch,
    serverExecutable: 'D:\\Flagchip\\JLink\\JLinkGDBServerCL.exe',
    gdbExecutable: 'D:\\Flagchip\\gcc\\bin\\arm-none-eabi-gdb.exe'
  }, 'E:\\project\\Debug_FLASH\\FC_Linhai_LCD.elf');
  assert.equal(launch.debugger, 'GNU MCU J-Link / J-Link GDB Server');
  assert.equal(plan.jlinkDevice, 'FC4150F512BSxXxxxT1A');
  assert.equal(plan.jlinkInterface, 'swd');
  assert.equal(plan.jlinkSpeed, '4000');
  assert.equal(plan.jlinkDevicesXmlPath, path.normalize('${eclipse_home}JLinkDevices/JLinkDevices.xml'));
  assert.equal(plan.jlinkCommanderExecutable, '');
  assert.equal(plan.gdbArguments.includes('monitor halt'), true);
  assert.equal(plan.gdbArguments.includes('monitor reset halt'), false);
});

test('reads Flagchip OpenOCD fields from an Eclipse launch configuration', () => {
  const launch = parseLaunchConfiguration(`<?xml version="1.0"?>
<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.openocd.launchConfigurationType">
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerExecutable" value="\${openocd_path}/\${openocd_executable}"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerOther" value="-f flagchip/fc4150f512_debug.cfg"/>
  <intAttribute key="ilg.gnumcueclipse.debug.gdbjtag.openocd.gdbServerGdbPortNumber" value="3333"/>
  <stringAttribute key="org.eclipse.cdt.debug.gdbjtag.core.ipAddress" value="localhost"/>
  <stringAttribute key="org.eclipse.cdt.debug.gdbjtag.core.jtagDevice" value="GNU MCU OpenOCD"/>
  <booleanAttribute key="org.eclipse.cdt.debug.gdbjtag.core.loadImage" value="true"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="Debug_FLASH/FC_Linhai_LCD.elf"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="FC_Linhai_LCD"/>
</launchConfiguration>`, 'C:\\workspace\\fc-openocd.launch');
  assert.equal(launch.serverKind, 'OpenOCD');
  assert.equal(launch.debugger, 'GNU MCU OpenOCD / OpenOCD');
  assert.equal(launch.port, 3333);
  assert.equal(launch.serverParameters, '-f flagchip/fc4150f512_debug.cfg');
});

test('discovers Flagchip launch tools and expands the Eclipse home variable', async (context) => {
  const ideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flagchip-launch-'));
  const launchDirectory = path.join(
    ideDirectory,
    'workspace',
    '.metadata',
    '.plugins',
    'org.eclipse.debug.core',
    '.launches'
  );
  const jlinkDirectory = path.join(ideDirectory, 'JLink');
  const gccDirectory = path.join(ideDirectory, 'gcc', 'bin');
  await Promise.all([
    fs.mkdir(launchDirectory, { recursive: true }),
    fs.mkdir(jlinkDirectory, { recursive: true }),
    fs.mkdir(gccDirectory, { recursive: true }),
    fs.mkdir(path.join(ideDirectory, 'JLinkDevices'), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(ideDirectory, 'Flagchip_FC_IDE.exe'), ''),
    fs.writeFile(path.join(ideDirectory, 'eclipsec.exe'), ''),
    fs.writeFile(path.join(jlinkDirectory, 'JLinkGDBServerCL.exe'), ''),
    fs.writeFile(path.join(jlinkDirectory, 'JLink.exe'), ''),
    fs.writeFile(path.join(gccDirectory, 'arm-none-eabi-gdb.exe'), ''),
    fs.writeFile(path.join(ideDirectory, 'JLinkDevices', 'JLinkDevices.xml'), ''),
    fs.writeFile(path.join(launchDirectory, 'demo.launch'), `<?xml version="1.0"?>
<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.jlink.launchConfigurationType">
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDeviceName" value="FC4150"/>
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerOther" value="-JLinkDevicesXMLPath &quot;\${eclipse_home}JLinkDevices/JLinkDevices.xml&quot;"/>
  <stringAttribute key="org.eclipse.cdt.dsf.gdb.DEBUG_NAME" value="\${cross_prefix}gdb\${cross_suffix}"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROGRAM_NAME" value="Debug/demo.elf"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="demo"/>
</launchConfiguration>`)
  ]);
  context.after(() => fs.rm(ideDirectory, { recursive: true, force: true }));
  const launches = await discoverLaunchConfigurations(
    path.join(ideDirectory, 'project'),
    'demo',
    path.join(ideDirectory, 'Flagchip_FC_IDE.exe')
  );
  assert.equal(launches.length, 1);
  assert.equal(launches[0].serverExecutable, path.join(jlinkDirectory, 'JLinkGDBServerCL.exe'));
  assert.equal(launches[0].gdbExecutable, path.join(gccDirectory, 'arm-none-eabi-gdb.exe'));
  const serverArguments = splitCommandLine(launches[0].serverParameters);
  const xmlPath = serverArguments[serverArguments.indexOf('-JLinkDevicesXMLPath') + 1];
  assert.equal(path.normalize(xmlPath), path.join(ideDirectory, 'JLinkDevices', 'JLinkDevices.xml'));
});

test('adds the vendor J-Link devices XML when a Flagchip launch omits it', async (context) => {
  const ideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flagchip-devices-'));
  const launchDirectory = path.join(
    ideDirectory,
    'workspace',
    '.metadata',
    '.plugins',
    'org.eclipse.debug.core',
    '.launches'
  );
  await fs.mkdir(launchDirectory, { recursive: true });
  await fs.mkdir(path.join(ideDirectory, 'JLinkDevices'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(ideDirectory, 'Flagchip_FC_IDE.exe'), ''),
    fs.writeFile(path.join(ideDirectory, 'eclipsec.exe'), ''),
    fs.writeFile(path.join(ideDirectory, 'JLinkDevices', 'JLinkDevices.xml'), ''),
    fs.writeFile(path.join(launchDirectory, 'demo.launch'), `<?xml version="1.0"?>
<launchConfiguration type="ilg.gnumcueclipse.debug.gdbjtag.jlink.launchConfigurationType">
  <stringAttribute key="ilg.gnumcueclipse.debug.gdbjtag.jlink.gdbServerDeviceName" value="FC4150"/>
  <stringAttribute key="org.eclipse.cdt.launch.PROJECT_ATTR" value="demo"/>
</launchConfiguration>`)
  ]);
  context.after(() => fs.rm(ideDirectory, { recursive: true, force: true }));
  const launches = await discoverLaunchConfigurations(
    path.join(ideDirectory, 'project'),
    'demo',
    path.join(ideDirectory, 'Flagchip_FC_IDE.exe')
  );
  const args = splitCommandLine(launches[0].serverParameters);
  const xmlPath = args[args.indexOf('-JLinkDevicesXMLPath') + 1];
  assert.equal(path.normalize(xmlPath), path.join(ideDirectory, 'JLinkDevices', 'JLinkDevices.xml'));
});

test('stores project flash files as portable relative paths', () => {
  const projectDirectory = 'E:\\projects\\demo';
  const flashFile = 'E:\\projects\\demo\\Debug_FLASH\\FC_DC50_IHU.elf';
  const relativePath = toProjectRelativePath(projectDirectory, flashFile);
  assert.equal(relativePath, 'Debug_FLASH/FC_DC50_IHU.elf');
  assert.equal(resolveElfPath(undefined, projectDirectory, relativePath), path.resolve(flashFile));
  assert.equal(
    toProjectRelativePath(projectDirectory, 'D:\\firmware\\external.hex'),
    path.resolve('D:\\firmware\\external.hex')
  );
});

test('expands Eclipse workspace_loc paths using slash variants and overrides', () => {
  const projectDirectory = 'E:\\projects\\FC_DC50_IHU';
  const launch = {
    projectName: 'FC_DC50_IHU',
    programName: '${workspace_loc:/FC_DC50_IHU/Debug_FLASH/mcu_app_ota.hex}',
    useFileForImage: false
  };
  assert.equal(
    resolveElfPath(launch, projectDirectory, ''),
    path.resolve(projectDirectory, 'Debug_FLASH', 'mcu_app_ota.hex')
  );
  assert.equal(
    resolveWorkspaceLocation(
      '${workspace_loc:\\FC_DC50_IHU\\Debug_FLASH\\FC_DC50_IHU.hex}',
      projectDirectory,
      'FC_DC50_IHU'
    ),
    path.resolve(projectDirectory, 'Debug_FLASH', 'FC_DC50_IHU.hex')
  );
  assert.equal(
    resolveElfPath(
      launch,
      projectDirectory,
      '${workspace_loc:/FC_DC50_IHU}/Debug_FLASH/FC_DC50_IHU.hex'
    ),
    path.resolve(projectDirectory, 'Debug_FLASH', 'FC_DC50_IHU.hex')
  );
  assert.equal(
    resolveWorkspaceLocation(
      '${workspace_loc:/OTHER_PROJECT/Debug/app.elf}',
      projectDirectory,
      'FC_DC50_IHU'
    ),
    ''
  );
});

test('creates a flash plan from vendor GDB server settings', () => {
  const plan = createFlashPlan({
    name: 'demo debug',
    debugger: 'GD-Link / OpenOCD',
    serverExecutable: 'D:\\Tools\\openocd.exe',
    serverParameters: '-f "E:\\project files\\openocd.cfg"',
    gdbExecutable: 'D:\\Tools\\arm-none-eabi-gdb.exe',
    host: 'localhost',
    port: 3333,
    remoteCommand: 'target remote',
    initCommands: '',
    resetCommands: '',
    runCommands: '',
    loadImage: true
  }, 'E:\\project files\\demo.elf');
  assert.deepEqual(plan.serverArguments, ['-f', 'E:\\project files\\openocd.cfg']);
  assert.equal(plan.gdbArguments.includes('load'), true);
  assert.equal(plan.gdbArguments.includes('target remote localhost:3333'), true);
  assert.equal(plan.gdbArguments.includes('monitor reset run'), true);
  assert.equal(plan.gdbArguments.includes('disconnect'), true);
  assert.equal(plan.gdbArguments.includes('detach'), false);
  assert.deepEqual(splitCommandLine('-port 2331 -device "GD32 L235"'), ['-port', '2331', '-device', 'GD32 L235']);
});

test('resets and runs a J-Link target after flashing', () => {
  const plan = createFlashPlan({
    name: 'demo debug',
    serverKind: 'JGDBServer',
    debugger: 'J-Link / J-Link GDB Server',
    serverExecutable: 'D:\\Tools\\JLinkGDBServerCL.exe',
    serverParameters: '-port 2331 -device GD32L235KBQ6 -if swd -speed 4000',
    gdbExecutable: 'D:\\Tools\\arm-none-eabi-gdb.exe',
    host: 'localhost',
    port: 2331,
    remoteCommand: 'target remote',
    resetCommands: 'monitor reset&#13;&#10;load&#13;&#10;',
    runCommands: 'monitor reset&#13;&#10;continue&#13;&#10;',
    loadImage: true
  }, 'E:\\project\\demo.elf');
  assert.equal(plan.gdbArguments.includes('monitor reset'), true);
  assert.equal(plan.gdbArguments.includes('monitor go'), true);
  assert.equal(plan.gdbArguments.includes('continue'), false);
  assert.equal(plan.gdbArguments.includes('disconnect'), true);
  assert.equal(plan.gdbArguments.some((argument) => argument.includes('&#13;')), false);
  assert.equal(plan.jlinkCommanderExecutable, path.resolve('D:\\Tools\\JLink.exe'));
  assert.equal(plan.jlinkDevice, 'GD32L235KBQ6');
});

test('creates a one-shot J-Link Commander script that runs and exits', () => {
  const script = createJLinkCommanderScript('E:\\project files\\demo.elf');
  assert.match(script, /loadfile "E:\/project files\/demo\.elf"/);
  assert.match(script, /\r\ng\r\nexit\r\n$/);
  assert.equal(script.includes('ExitOnError 1'), true);
});

test('waits for a J-Link target connection instead of its listening socket', () => {
  assert.equal(
    serverOutputState('Listening on TCP/IP port 2331', 'J-Link / J-Link GDB Server'),
    'waiting'
  );
  assert.equal(
    serverOutputState('Connected to target\nWaiting for GDB connection', 'J-Link / J-Link GDB Server'),
    'ready'
  );
  assert.equal(
    serverOutputState('ERROR: J-Link script file function InitTarget() returned with error code -1', 'J-Link / J-Link GDB Server'),
    'failed'
  );
  assert.equal(
    serverOutputState('Info : Listening on port 3333 for gdb connections', 'GD-Link / OpenOCD'),
    'ready'
  );
});

test('treats GDB server programming and verification errors as flash failures', () => {
  assert.equal(downloadOutputFailed('ERROR: Verification failed @ address 0x00030400'), true);
  assert.equal(downloadOutputFailed('Programming flash [....................] Done.'), false);
  assert.equal(downloadOutputFailed('Flash download successful'), false);
  assert.equal(downloadOutputFailed('Flash download failed'), true);
});
