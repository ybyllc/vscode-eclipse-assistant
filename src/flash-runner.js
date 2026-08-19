const fs = require('node:fs/promises');
const os = require('node:os');
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

function argumentValue(argumentsList, name) {
  const index = argumentsList.findIndex((argument) => argument.toLowerCase() === name.toLowerCase());
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

function createFlashPlan(launch, elfPath) {
  if (!launch) {
    throw new Error('没有选择Eclipse烧录配置。');
  }
  if (!launch.serverExecutable) {
    throw new Error(`烧录配置“${launch.name}”中没有GDB Server路径。`);
  }
  if (!launch.gdbExecutable) {
    throw new Error(`烧录配置“${launch.name}”中没有GDB路径。`);
  }
  if (!elfPath) {
    throw new Error(`烧录配置“${launch.name}”中没有ELF文件。`);
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
  const serverArguments = splitCommandLine(launch.serverParameters);
  const isJLink = /j-link|jgdbserver/i.test(`${launch.serverKind || ''} ${launch.debugger || ''}`);
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
    jlinkCommanderExecutable: isJLink
      ? path.join(path.dirname(path.resolve(launch.serverExecutable)), 'JLink.exe')
      : '',
    jlinkDevice: argumentValue(serverArguments, '-device') || '',
    jlinkInterface: argumentValue(serverArguments, '-if') || launch.interface || 'swd',
    jlinkSpeed: argumentValue(serverArguments, '-speed') || launch.speed || 'auto'
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
  const error = new Error('烧录已由用户停止。');
  error.name = 'AbortError';
  return error;
}

function waitForServerReady(serverProcess, debuggerName, onOutput, signal, timeoutMilliseconds = 15000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待GDB Server连接目标超时，已停止烧录。'));
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
        reject(new Error('J-Link无法连接目标，InitTarget失败。请检查芯片型号、接线、复位方式或改用已验证的GD-Link/OpenOCD配置。'));
      } else if (state === 'ready') {
        cleanup();
        resolve();
      }
    }
    function exited(code) {
      cleanup();
      reject(new Error(`GDB Server在连接目标前退出，退出代码：${code}。`));
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
      reject(new Error(`${label}在${Math.round(timeoutMilliseconds / 1000)}秒内没有结束，已强制停止。`));
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
        reject(new Error('GDB下载失败：目标连接中断或烧录命令未被GDB Server接受。'));
      } else {
        reject(new Error(`${label}异常退出，退出代码：${code}。`));
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
    throw new Error('J-Link烧录配置中缺少-device芯片型号参数。');
  }
  await Promise.all([
    fs.access(plan.jlinkCommanderExecutable),
    fs.access(plan.elfPath)
  ]);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gd32-jlink-'));
  const scriptPath = path.join(tempDirectory, 'flash.jlink');
  await fs.writeFile(scriptPath, createJLinkCommanderScript(plan.elfPath), 'utf8');
  const args = [
    '-device', plan.jlinkDevice,
    '-if', plan.jlinkInterface,
    '-speed', plan.jlinkSpeed,
    '-autoconnect', '1',
    '-ExitOnError', '1',
    '-CommanderScript', scriptPath
  ];
  let commander;
  try {
    onOutput(`烧录方式：J-Link Commander\n芯片型号：${plan.jlinkDevice}\n接口：${plan.jlinkInterface.toUpperCase()}\n速度：${plan.jlinkSpeed} kHz\n\n`);
    commander = spawn(plan.jlinkCommanderExecutable, args, {
      cwd: path.dirname(plan.jlinkCommanderExecutable),
      windowsHide: true
    });
    const output = await waitForExit(commander, 'J-Link Commander', onOutput, signal);
    if (!/O\.K\.|Flash download.*(?:finished|successful)/i.test(output)) {
      throw new Error('J-Link Commander没有报告烧录成功。');
    }
    onOutput('\n烧录完成，目标程序已复位运行，J-Link Commander已退出。\n');
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
  onOutput(`烧录配置：${plan.launchName}\n调试器：${plan.debugger}\nELF文件：${plan.elfPath}\n\n`);
  if (plan.jlinkCommanderExecutable) {
    await runJLinkCommander(plan, onOutput, signal);
    return;
  }
  await Promise.all([
    fs.access(plan.serverExecutable),
    fs.access(plan.gdbExecutable),
    fs.access(plan.elfPath)
  ]);
  onOutput('正在连接目标...\n');
  const server = spawn(plan.serverExecutable, plan.serverArguments, {
    cwd: path.dirname(plan.serverExecutable),
    windowsHide: true
  });
  let gdb;
  try {
    await waitForServerReady(server, plan.debugger, onOutput, signal);
    onOutput('\n目标连接成功，开始下载ELF...\n');
    server.stdout?.on('data', (data) => onOutput(data.toString()));
    server.stderr?.on('data', (data) => onOutput(data.toString()));
    gdb = spawn(plan.gdbExecutable, plan.gdbArguments, {
      cwd: path.dirname(plan.elfPath),
      windowsHide: true
    });
    await waitForExit(gdb, 'GDB', onOutput, signal);
    onOutput('\n烧录完成，目标程序已复位运行。\n');
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
