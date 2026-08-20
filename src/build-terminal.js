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
  white: '\x1b[37m',
  error256: '\x1b[38;5;203m',
  warning256: '\x1b[38;5;214m',
  success256: '\x1b[38;5;77m',
  stage256: '\x1b[38;5;45m',
  command256: '\x1b[38;5;244m',
  size256: '\x1b[38;5;141m'
};

function safeText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function terminalText(chunk) {
  return chunk.toString('utf8').replace(/(^|[^\r])\n/g, '$1\r\n');
}

function highlightBuildLine(line) {
  if (!line || line.includes('\x1b[')) {
    return line;
  }
  const matchableLine = line
    .replace(/\b0\s+errors?\b/gi, '')
    .replace(/\b0\s+warnings?\b/gi, '');
  const rules = [
    {
      pattern: /(?:\bfatal(?: error)?\b|\berror\b|undefined reference|collect2:|make(?:\.exe)?: \*\*\*|build failed)/i,
      color: ANSI.error256
    },
    {
      pattern: /(?:\bwarning\b|\bwarn\s*:)/i,
      color: ANSI.warning256
    },
    {
      pattern: /(?:build (?:finished|complete|completed|successful|succeeded)|finished building)/i,
      color: ANSI.success256
    },
    {
      pattern: /(?:\*{2,}\s*build of configuration|\bbuilding file\b|\binvoking\b|\bstarting build\b)/i,
      color: ANSI.stage256
    },
    {
      pattern: /^\s*(?:"?[A-Za-z]:[^\r\n]*\\)?(?:arm-none-eabi-)?(?:gcc|g\+\+|as|ld|objcopy|objdump|size|make)(?:\.exe)?\b/i,
      color: ANSI.command256
    },
    {
      pattern: /^\s*(?:text\s+data\s+bss\s+dec\s+hex\s+filename|\d+\s+\d+\s+\d+\s+\d+\s+[0-9a-f]+\s+\S+)/i,
      color: ANSI.size256
    }
  ];
  const match = rules.find((rule) => rule.pattern.test(matchableLine));
  return match ? `${match.color}${line}${ANSI.reset}` : line;
}

function createBuildLogHighlighter(onWrite) {
  let pending = '';
  return {
    write(chunk) {
      const text = pending + chunk.toString('utf8');
      const lines = text.split('\n');
      pending = lines.pop();
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        onWrite(`${highlightBuildLine(line)}\r\n`);
      }
    },
    flush() {
      if (pending) {
        onWrite(highlightBuildLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending));
        pending = '';
      }
    }
  };
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
  const stdout = createBuildLogHighlighter((text) => writeEmitter.fire(text));
  const stderr = createBuildLogHighlighter((text) => writeEmitter.fire(text));

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
      child.stdout.on('data', (chunk) => stdout.write(chunk));
      child.stderr.on('data', (chunk) => stderr.write(chunk));
      child.once('error', (error) => {
        stdout.flush();
        stderr.flush();
        finish(-1, 'failed', options.failedLabel(-1, 0, error.message));
      });
      child.once('close', (exitCode) => {
        stdout.flush();
        stderr.flush();
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
  createBuildLogHighlighter,
  createBuildPseudoterminal,
  formatBuildBanner,
  formatBuildResult,
  highlightBuildLine,
  safeText,
  terminalText
};
