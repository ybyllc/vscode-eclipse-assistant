const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createHeadlessArgs,
  getDefaultWorkspacePath,
  getExecutable
} = require('../src/headless-command');
const { findProjectRoot, readProjectInfo } = require('../src/project-model');
const { createFlashPlan, serverOutputState, splitCommandLine } = require('../src/flash-runner');
const { parseLaunchConfiguration, resolveElfPath } = require('../src/launch-model');

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

test('accepts either an installation folder or executable path', () => {
  assert.equal(
    getExecutable('D:\\GD32EB'),
    path.resolve('D:\\GD32EB', 'GD32EmbeddedBuilderc.exe')
  );
  assert.equal(
    getExecutable('D:\\GD32EB\\GD32EmbeddedBuilderc.exe'),
    path.resolve('D:\\GD32EB\\GD32EmbeddedBuilderc.exe')
  );
  assert.equal(
    getExecutable('D:\\GD32EB\\GD32EmbeddedBuilder.exe'),
    path.resolve('D:\\GD32EB\\GD32EmbeddedBuilderc.exe')
  );
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
    serverParameters: '-port 2331',
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
