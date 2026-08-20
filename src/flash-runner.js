const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { t } = require('./i18n');

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

function argumentValue(argumentsList, name) {
  const index = argumentsList.findIndex((argument) => argument.toLowerCase() === name.toLowerCase());
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

function createFlashPlan(launch, elfPath) {
  if (!launch) {
    throw new Error(t('error.noLaunch'));
  }
  if (!launch.serverExecutable) {
    throw new Error(t('error.noGdbServer', launch.name));
  }
  if (!launch.gdbExecutable) {
    throw new Error(t('error.noGdb', launch.name));
  }
  if (!elfPath) {
    throw new Error(t('error.noFlashFile', launch.name));
  }

  const debuggerKind = `${launch.serverKind || ''} ${launch.debugger || ''}`;
  const isJLink = /j-link|jgdbserver/i.test(debuggerKind);
  const isOpenOcd = /openocd/i.test(debuggerKind);
  const resetCommands = commandLines(launch.resetCommands);
  const runCommands = commandLines(launch.runCommands)
    .filter((command) => !/^(continue|c|tbreak\b|monitor\s+reset\b)/i.test(command));
  if (launch.loadImage && !resetCommands.some((command) => /^load(?:\s|$)/i.test(command))) {
    resetCommands.push(...(isJLink
      ? ['monitor reset', 'monitor halt', 'load']
      : ['monitor reset halt', 'load']));
  }
  const resumeCommands = isOpenOcd
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
  const serverArguments = splitCommandLine(launch.serverParameters);
  const rawDevicesXmlPath = argumentValue(serverArguments, '-JLinkDevicesXMLPath') || '';
  const jlinkDevicesXmlPath = rawDevicesXmlPath ? path.normalize(rawDevicesXmlPath) : '';
  return {
    serverExecutable: path.resolve(launch.serverExecutable),
    serverArguments,
    gdbExecutable: path.resolve(launch.gdbExecutable),
    gdbArguments: ['--quiet', '--batch', ...gdbCommands.flatMap((command) => ['-ex', command])],
    host: launch.host || 'localhost',
    port: launch.port || 3333,
    elfPath: path.resolve(elfPath),
    launchName: launch.name,
    debugger: launch.debugger,
    jlinkCommanderExecutable: isJLink && !jlinkDevicesXmlPath
      ? path.join(path.dirname(path.resolve(launch.serverExecutable)), 'JLink.exe')
      : '',
    jlinkDevice: argumentValue(serverArguments, '-device') || '',
    jlinkInterface: argumentValue(serverArguments, '-if') || launch.interface || 'swd',
    jlinkSpeed: argumentValue(serverArguments, '-speed') || launch.speed || 'auto',
    jlinkDevicesXmlPath
  };
}

function createJLinkCommanderScript(elfPath) {
  const commanderPath = path.resolve(elfPath).replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    'ExitOnError 1',
    'r',
    'h',
    `loadfile "${commanderPath}"`,
    'r',
    'g',
    'exit',
    ''
  ].join('\r\n');
}

function serverOutputState(output, debuggerName) {
  if (/InitTarget\(\).*error|Could not connect to target|Target connection failed/i.test(output)) {
    return 'failed';
  }
  const ready = /j-link/i.test(debuggerName)
    ? /Connected to target|Waiting for GDB connection/i.test(output)
    : /Listening on (?:TCP\/IP )?port \d+.*gdb connections/i.test(output);
  return ready ? 'ready' : 'waiting';
}

function cancellationError() {
  const error = new Error(t('log.stopped'));
  error.name = 'AbortError';
  return error;
}

function waitForServerReady(serverProcess, debuggerName, onOutput, signal, timeoutMilliseconds = 15000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t('error.jlinkTimeout')));
    }, timeoutMilliseconds);
    function cleanup() {
      clearTimeout(timer);
      serverProcess.stdout?.off('data', inspect);
      serverProcess.stderr?.off('data', inspect);
      serverProcess.off('exit', exited);
      serverProcess.off('error', failed);
      signal?.removeEventListener('abort', cancelled);
    }
    function inspect(data) {
      const text = data.toString();
      output += text;
      onOutput(text);
      const state = serverOutputState(output, debuggerName);
      if (state === 'failed') {
        cleanup();
        reject(new Error(t('error.jlinkInitFailed')));
      } else if (state === 'ready') {
        cleanup();
        resolve();
      }
    }
    function exited(code) {
      cleanup();
      reject(new Error(t('error.gdbServerExited', code)));
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    function cancelled() {
      cleanup();
      reject(cancellationError());
    }
    serverProcess.stdout?.on('data', inspect);
    serverProcess.stderr?.on('data', inspect);
    serverProcess.once('exit', exited);
    serverProcess.once('error', failed);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) {
      cancelled();
    }
  });
}

function waitForExit(process, label, onOutput, signal, timeoutMilliseconds = 60000) {
  let output = '';
  process.stdout?.on('data', (data) => onOutput(data.toString()));
  process.stderr?.on('data', (data) => onOutput(data.toString()));
  process.stdout?.on('data', (data) => { output += data.toString(); });
  process.stderr?.on('data', (data) => { output += data.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      process.kill();
      reject(new Error(t('error.processTimeout', label, Math.round(timeoutMilliseconds / 1000))));
    }, timeoutMilliseconds);
    function cleanup() {
      clearTimeout(timer);
      process.off('error', failed);
      process.off('exit', exited);
      signal?.removeEventListener('abort', cancelled);
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    function exited(code) {
      cleanup();
      const commandFailed = /Remote communication error|Target disconnected|not supported by this target|You can't do that|Load failed/i.test(output);
      if (code === 0 && !commandFailed) {
        resolve(output);
      } else if (commandFailed) {
        reject(new Error(t('error.gdbDownloadFailed')));
      } else {
        reject(new Error(t('error.processExited', label, code)));
      }
    }
    function cancelled() {
      cleanup();
      process.kill();
      reject(cancellationError());
    }
    process.once('error', failed);
    process.once('exit', exited);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) {
      cancelled();
    }
  });
}

async function runJLinkCommander(plan, onOutput, signal) {
  if (!plan.jlinkDevice) {
    throw new Error(t('error.jlinkNoDevice'));
  }
  await Promise.all([
    fs.access(plan.jlinkCommanderExecutable),
    fs.access(plan.elfPath)
  ]);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'eclipse-jlink-'));
  const scriptPath = path.join(tempDirectory, 'flash.jlink');
  await fs.writeFile(scriptPath, createJLinkCommanderScript(plan.elfPath), 'utf8');
  const args = [
    '-device', plan.jlinkDevice,
    '-if', plan.jlinkInterface,
    '-speed', plan.jlinkSpeed,
    '-autoconnect', '1',
    '-ExitOnError', '1'
  ];
  args.push('-CommanderScript', scriptPath);
  let commander;
  try {
    onOutput(t('log.jlinkHeader', plan.jlinkDevice, plan.jlinkInterface.toUpperCase(), plan.jlinkSpeed));
    commander = spawn(plan.jlinkCommanderExecutable, args, {
      cwd: path.dirname(plan.jlinkCommanderExecutable),
      windowsHide: true
    });
    const output = await waitForExit(commander, 'J-Link Commander', onOutput, signal);
    if (!/O\.K\.|Flash download.*(?:finished|successful)/i.test(output)) {
      throw new Error(t('error.jlinkNoSuccess'));
    }
    onOutput(t('log.flashDoneJlink'));
  } finally {
    await terminateProcess(commander);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
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

async function runFlashPlan(plan, onOutput = () => {}, signal) {
  if (signal?.aborted) {
    throw cancellationError();
  }
  onOutput(t('log.header', plan.launchName, plan.debugger, plan.elfPath));
  if (plan.jlinkCommanderExecutable) {
    await runJLinkCommander(plan, onOutput, signal);
    return;
  }
  await Promise.all([
    fs.access(plan.serverExecutable),
    fs.access(plan.gdbExecutable),
    fs.access(plan.elfPath)
  ]);
  onOutput(t('log.connecting'));
  const server = spawn(plan.serverExecutable, plan.serverArguments, {
    cwd: path.dirname(plan.serverExecutable),
    windowsHide: true
  });
  let gdb;
  try {
    await waitForServerReady(server, plan.debugger, onOutput, signal);
    onOutput(t('log.connected'));
    server.stdout?.on('data', (data) => onOutput(data.toString()));
    server.stderr?.on('data', (data) => onOutput(data.toString()));
    gdb = spawn(plan.gdbExecutable, plan.gdbArguments, {
      cwd: path.dirname(plan.elfPath),
      windowsHide: true
    });
    await waitForExit(gdb, 'GDB', onOutput, signal);
    onOutput(t('log.flashDone'));
  } finally {
    await terminateProcess(gdb);
    await terminateProcess(server);
  }
}

module.exports = {
  createFlashPlan,
  createJLinkCommanderScript,
  runFlashPlan,
  serverOutputState,
  splitCommandLine
};
