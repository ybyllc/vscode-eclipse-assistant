const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function splitCommandLine(commandLine) {
  const values = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(commandLine)) !== null) {
    values.push(match[1] ?? match[2] ?? match[3]);
  }
  return values;
}

function commandLines(value) {
  return String(value || '')
    .replace(/&#(?:13|x0*d);/gi, '\r')
    .replace(/&#(?:10|x0*a);/gi, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function quoteGdbPath(filePath) {
  return `"${filePath.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function createFlashPlan(launch, elfPath) {
  if (!launch) {
    throw new Error('No Eclipse flash configuration is selected.');
  }
  if (!launch.serverExecutable) {
    throw new Error(`No GDB Server executable was found in "${launch.name}".`);
  }
  if (!launch.gdbExecutable) {
    throw new Error(`No GDB executable was found in "${launch.name}".`);
  }
  if (!elfPath) {
    throw new Error(`No ELF file was found in "${launch.name}".`);
  }

  const resetCommands = commandLines(launch.resetCommands);
  const runCommands = commandLines(launch.runCommands)
    .filter((command) => !/^(continue|c|tbreak\b|monitor\s+reset\b)/i.test(command));
  if (launch.loadImage && !resetCommands.some((command) => /^load(?:\s|$)/i.test(command))) {
    resetCommands.push('monitor reset halt', 'load');
  }
  const resumeCommands = /openocd/i.test(`${launch.serverKind || ''} ${launch.debugger || ''}`)
    ? ['monitor reset run']
    : ['monitor reset', 'monitor go'];

  const gdbCommands = [
    'set confirm off',
    `file ${quoteGdbPath(path.resolve(elfPath))}`,
    ...commandLines(launch.initCommands),
    `${launch.remoteCommand || 'target remote'} ${launch.host || 'localhost'}:${launch.port || 3333}`,
    ...resetCommands,
    ...runCommands,
    ...resumeCommands,
    'disconnect',
    'quit'
  ];
  return {
    serverExecutable: path.resolve(launch.serverExecutable),
    serverArguments: splitCommandLine(launch.serverParameters),
    gdbExecutable: path.resolve(launch.gdbExecutable),
    gdbArguments: ['--quiet', '--batch', ...gdbCommands.flatMap((command) => ['-ex', command])],
    host: launch.host || 'localhost',
    port: launch.port || 3333,
    elfPath: path.resolve(elfPath),
    launchName: launch.name,
    debugger: launch.debugger
  };
}

function waitForServerReady(serverProcess, onOutput, timeoutMilliseconds = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for GDB Server to become ready.'));
    }, timeoutMilliseconds);
    function cleanup() {
      clearTimeout(timer);
      serverProcess.stdout?.off('data', inspect);
      serverProcess.stderr?.off('data', inspect);
      serverProcess.off('exit', exited);
      serverProcess.off('error', failed);
    }
    function inspect(data) {
      const text = data.toString();
      output += text;
      onOutput(text);
      if (/Listening on (?:TCP\/IP )?port \d+/i.test(output)) {
        cleanup();
        resolve();
      }
    }
    function exited(code) {
      cleanup();
      reject(new Error(`GDB Server exited with code ${code} before becoming ready.`));
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    serverProcess.stdout?.on('data', inspect);
    serverProcess.stderr?.on('data', inspect);
    serverProcess.once('exit', exited);
    serverProcess.once('error', failed);
  });
}

function waitForExit(process, label, onOutput, timeoutMilliseconds = 60000) {
  process.stdout?.on('data', (data) => onOutput(data.toString()));
  process.stderr?.on('data', (data) => onOutput(data.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      process.kill();
      reject(new Error(`${label} did not exit within ${Math.round(timeoutMilliseconds / 1000)} seconds.`));
    }, timeoutMilliseconds);
    function cleanup() {
      clearTimeout(timer);
      process.off('error', failed);
      process.off('exit', exited);
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    function exited(code) {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code}.`));
      }
    }
    process.once('error', failed);
    process.once('exit', exited);
  });
}

async function terminateProcess(process, timeoutMilliseconds = 2000) {
  if (!process || process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMilliseconds);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill();
  });
}

async function runFlashPlan(plan, onOutput = () => {}) {
  await Promise.all([
    fs.access(plan.serverExecutable),
    fs.access(plan.gdbExecutable),
    fs.access(plan.elfPath)
  ]);
  onOutput(`Flash configuration: ${plan.launchName}\nDebugger: ${plan.debugger}\nELF: ${plan.elfPath}\n\n`);
  const server = spawn(plan.serverExecutable, plan.serverArguments, {
    cwd: path.dirname(plan.serverExecutable),
    windowsHide: true
  });
  let gdb;
  try {
    await waitForServerReady(server, onOutput);
    server.stdout?.on('data', (data) => onOutput(data.toString()));
    server.stderr?.on('data', (data) => onOutput(data.toString()));
    gdb = spawn(plan.gdbExecutable, plan.gdbArguments, {
      cwd: path.dirname(plan.elfPath),
      windowsHide: true
    });
    await waitForExit(gdb, 'GDB', onOutput);
  } finally {
    await terminateProcess(gdb);
    await terminateProcess(server);
  }
}

module.exports = {
  createFlashPlan,
  runFlashPlan,
  splitCommandLine
};
