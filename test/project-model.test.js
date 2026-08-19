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
});

test('creates a stable and project-specific headless workspace path', () => {
  const first = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\demo');
  const repeated = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\demo');
  const second = getDefaultWorkspacePath('D:\\extension-data', 'E:\\projects\\other');
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.equal(first.startsWith(path.resolve('D:\\extension-data', 'workspaces')), true);
});
