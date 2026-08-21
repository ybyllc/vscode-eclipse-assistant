const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FAILED_LOGS = 5;

function safeFileName(value) {
  return String(value || 'build')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || 'build';
}

function localTimestamp(date) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function quoteCommandArgument(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function createLogHeader(options, startedAt) {
  const command = [options.executable, ...(options.args || [])].map(quoteCommandArgument).join(' ');
  return [
    'Eclipse Assistant - Failed Build Log',
    `Time: ${startedAt.toISOString()}`,
    `Project: ${options.projectName}`,
    `Configuration: ${options.configuration}`,
    `Eclipse client: ${options.executable}`,
    `Command: ${command}`,
    '-'.repeat(80),
    ''
  ].join('\r\n');
}

async function removeStaleTemporaryLogs(directory, now) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const staleBefore = now.getTime() - 24 * 60 * 60 * 1000;
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
    .map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stats = await fs.stat(filePath).catch(() => undefined);
      if (stats && stats.mtimeMs < staleBefore) {
        await fs.unlink(filePath).catch(() => {});
      }
    }));
}

async function pruneFailedLogs(directory, limit) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const logs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(logs.slice(limit).map((name) => fs.unlink(path.join(directory, name))));
}

/** Creates a temporary build log that is retained only when the build fails. */
async function createBuildFailureLogger(options) {
  const limit = Math.max(0, Math.min(MAX_FAILED_LOGS, Math.trunc(Number(options.limit) || 0)));
  if (limit === 0) {
    return undefined;
  }

  const startedAt = options.now || new Date();
  const projectHash = crypto.createHash('sha256').update(path.resolve(options.projectDirectory)).digest('hex').slice(0, 12);
  const projectDirectory = `${safeFileName(options.projectName)}-${projectHash}`;
  const logDirectory = path.join(options.baseDirectory, projectDirectory);
  await fs.mkdir(logDirectory, { recursive: true });
  await removeStaleTemporaryLogs(logDirectory, startedAt);

  const token = crypto.randomUUID();
  const temporaryPath = path.join(logDirectory, `.${token}.tmp`);
  const finalPath = path.join(
    logDirectory,
    `${localTimestamp(startedAt)}_${safeFileName(options.configuration)}_${token.slice(0, 8)}.log`
  );
  const file = await fs.open(temporaryPath, 'wx');
  await file.writeFile(createLogHeader(options, startedAt), 'utf8');
  let pendingWrite = Promise.resolve();
  let completed = false;

  return {
    append(chunk) {
      if (!completed) {
        pendingWrite = pendingWrite.then(() => file.appendFile(chunk));
      }
    },
    async complete(kind, resultText = '') {
      if (completed) {
        return undefined;
      }
      if (resultText) {
        pendingWrite = pendingWrite.then(() => file.appendFile(resultText, 'utf8'));
      }
      completed = true;
      try {
        await pendingWrite;
      } finally {
        await file.close();
      }

      if (kind !== 'failed') {
        await fs.unlink(temporaryPath).catch(() => {});
        return undefined;
      }

      await fs.rename(temporaryPath, finalPath);
      await pruneFailedLogs(logDirectory, limit);
      return finalPath;
    }
  };
}

module.exports = {
  MAX_FAILED_LOGS,
  createBuildFailureLogger,
  safeFileName
};
