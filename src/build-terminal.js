const { spawn } = require('node:child_process');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function safeText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function terminalText(chunk) {
  return chunk.toString('utf8').replace(/(^|[^\r])\n/g, '$1\r\n');
}

function formatBuildBanner(options) {
  const action = options.cleanBuildLabel || options.buildLabel;
  return [
    `${ANSI.bold}${ANSI.cyan}[Eclipse CDT]${ANSI.reset} ${ANSI.bold}${ANSI.blue}${safeText(action)}${ANSI.reset}`,
    `${ANSI.dim}${safeText(options.projectLabel)}:${ANSI.reset} ${ANSI.bold}${ANSI.white}${safeText(options.projectName)}${ANSI.reset}  ${ANSI.dim}${safeText(options.configurationLabel)}:${ANSI.reset} ${ANSI.bold}${ANSI.magenta}${safeText(options.configuration)}${ANSI.reset}`,
    `${ANSI.dim}${safeText(options.ideLabel)}:${ANSI.reset} ${safeText(options.executable)}`,
    `${ANSI.dim}${'-'.repeat(72)}${ANSI.reset}`,
    ''
  ].join('\r\n');
}

function formatBuildResult(kind, message) {
  const color = kind === 'success'
    ? ANSI.green
    : kind === 'stopped'
      ? ANSI.yellow
      : ANSI.red;
  return `\r\n${ANSI.bold}${color}${safeText(message)}${ANSI.reset}\r\n`;
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
}

/** Creates a VS Code pseudoterminal that preserves process output and exit codes. */
function createBuildPseudoterminal(vscode, options) {
  const writeEmitter = new vscode.EventEmitter();
  const closeEmitter = new vscode.EventEmitter();
  let child;
  let completed = false;
  let startedAt;

  const finish = (exitCode, kind, message) => {
    if (completed) {
      return;
    }
    completed = true;
    writeEmitter.fire(formatBuildResult(kind, message));
    closeEmitter.fire(exitCode);
  };

  return {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open() {
      startedAt = Date.now();
      writeEmitter.fire(formatBuildBanner(options));
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', (chunk) => writeEmitter.fire(terminalText(chunk)));
      child.stderr.on('data', (chunk) => writeEmitter.fire(terminalText(chunk)));
      child.once('error', (error) => {
        finish(-1, 'failed', options.failedLabel(-1, 0, error.message));
      });
      child.once('close', (exitCode) => {
        const duration = Math.max(0, (Date.now() - startedAt) / 1000);
        if (exitCode === 0) {
          finish(0, 'success', options.successLabel(duration));
        } else {
          finish(exitCode ?? -1, 'failed', options.failedLabel(exitCode ?? -1, duration));
        }
      });
    },
    close() {
      if (!completed) {
        stopProcessTree(child);
        finish(130, 'stopped', options.stoppedLabel);
      }
      writeEmitter.dispose();
      closeEmitter.dispose();
    }
  };
}

module.exports = {
  ANSI,
  createBuildPseudoterminal,
  formatBuildBanner,
  formatBuildResult,
  safeText,
  terminalText
};
