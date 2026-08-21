const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBuildFailureLogger, resolveBuildLogBaseDirectory } = require('../src/build-log');

async function createTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eclipse-assistant-log-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function loggerOptions(baseDirectory, overrides = {}) {
  return {
    baseDirectory,
    projectDirectory: path.join(baseDirectory, 'Demo'),
    projectName: 'Demo',
    configuration: 'Debug',
    executable: 'C:\\Eclipse\\eclipsec.exe',
    args: ['-build', 'Demo/Debug'],
    limit: 5,
    ...overrides
  };
}

async function listFilesRecursively(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

test('retains failed builds but removes successful and stopped temporary logs', async (t) => {
  const directory = await createTemporaryDirectory(t);

  const failed = await createBuildFailureLogger(loggerOptions(directory));
  failed.append('compiler error\r\n');
  const failedPath = await failed.complete('failed', 'Build failed\r\n');

  const successful = await createBuildFailureLogger(loggerOptions(directory));
  successful.append('Build successful\r\n');
  assert.equal(await successful.complete('success'), undefined);

  const stopped = await createBuildFailureLogger(loggerOptions(directory));
  stopped.append('Stopped\r\n');
  assert.equal(await stopped.complete('stopped'), undefined);

  const files = await listFilesRecursively(directory);
  assert.deepEqual(files.filter((file) => file.endsWith('.log')), [failedPath]);
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);
  assert.match(await fs.readFile(failedPath, 'utf8'), /compiler error[\s\S]*Build failed/);
});

test('keeps at most five failed logs per project', async (t) => {
  const directory = await createTemporaryDirectory(t);
  for (let index = 0; index < 7; index += 1) {
    const logger = await createBuildFailureLogger(loggerOptions(directory, {
      now: new Date(2026, 7, 21, 10, 0, index)
    }));
    logger.append(`failure ${index}`);
    await logger.complete('failed');
  }

  const files = (await listFilesRecursively(directory)).filter((file) => file.endsWith('.log'));
  assert.equal(files.length, 5);
  assert.equal(files.some((file) => path.basename(file).startsWith('2026-08-21_10-00-00')), false);
  assert.equal(files.some((file) => path.basename(file).startsWith('2026-08-21_10-00-06')), true);
});

test('zero retention disables build log creation', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const logger = await createBuildFailureLogger(loggerOptions(directory, { limit: 0 }));
  assert.equal(logger, undefined);
  assert.deepEqual(await listFilesRecursively(directory), []);
});

test('resolves default, absolute, relative, and variable-based log directories', () => {
  const projectDirectory = path.resolve('C:\\projects\\Demo');
  const workspaceDirectory = path.resolve('C:\\projects');
  const defaultDirectory = path.resolve('C:\\extension-storage\\build-logs');

  assert.equal(resolveBuildLogBaseDirectory('', defaultDirectory, projectDirectory), defaultDirectory);
  assert.equal(
    resolveBuildLogBaseDirectory('logs', defaultDirectory, projectDirectory),
    path.resolve(projectDirectory, 'logs')
  );
  assert.equal(
    resolveBuildLogBaseDirectory('${projectDir}\\.logs', defaultDirectory, projectDirectory),
    path.resolve(projectDirectory, '.logs')
  );
  assert.equal(
    resolveBuildLogBaseDirectory('${workspaceFolder}\\logs', defaultDirectory, projectDirectory, workspaceDirectory),
    path.resolve(workspaceDirectory, 'logs')
  );
});
