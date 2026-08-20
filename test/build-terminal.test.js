const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ANSI,
  formatBuildBanner,
  formatBuildResult,
  safeText,
  terminalText
} = require('../src/build-terminal');

test('build banner applies separate colors to the action and configuration', () => {
  const banner = formatBuildBanner({
    buildLabel: 'BUILD',
    projectLabel: 'Project',
    projectName: 'Demo',
    configurationLabel: 'Configuration',
    configuration: 'Debug',
    ideLabel: 'Eclipse client',
    executable: 'C:\\Eclipse\\eclipsec.exe'
  });

  assert.ok(banner.includes(ANSI.blue));
  assert.ok(banner.includes(ANSI.magenta));
  assert.match(banner, /Demo/);
  assert.match(banner, /Debug/);
});

test('result colors reflect success, failure, and stop states', () => {
  assert.ok(formatBuildResult('success', 'done').includes(ANSI.green));
  assert.ok(formatBuildResult('failed', 'failed').includes(ANSI.red));
  assert.ok(formatBuildResult('stopped', 'stopped').includes(ANSI.yellow));
});

test('terminal text preserves CRLF and converts bare newlines', () => {
  assert.equal(terminalText(Buffer.from('one\ntwo\r\n')), 'one\r\ntwo\r\n');
});

test('banner values cannot inject terminal control sequences', () => {
  assert.equal(safeText('Demo\x1b[31m\n'), 'Demo[31m');
});
