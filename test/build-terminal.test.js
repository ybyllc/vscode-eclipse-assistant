const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ANSI,
  createBuildLogHighlighter,
  formatBuildBanner,
  formatBuildResult,
  highlightBuildLine,
  isManagedBuildCompatibilityError,
  plainTerminalText,
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

test('saved terminal text removes ANSI colors', () => {
  assert.equal(plainTerminalText(`${ANSI.red}failed${ANSI.reset}\n`), 'failed\r\n');
});

test('banner values cannot inject terminal control sequences', () => {
  assert.equal(safeText('Demo\x1b[31m\n'), 'Demo[31m');
});

test('build log rules apply xterm-256 colors by severity and line type', () => {
  assert.ok(highlightBuildLine('main.c:10: error: failed').startsWith(ANSI.error256));
  assert.ok(highlightBuildLine('main.c:10: warning: unused').startsWith(ANSI.warning256));
  assert.ok(highlightBuildLine('Finished building: app.elf').startsWith(ANSI.success256));
  assert.ok(highlightBuildLine('Download successful').startsWith(ANSI.success256));
  assert.ok(highlightBuildLine('Download not successful').startsWith(ANSI.error256));
  assert.ok(highlightBuildLine('Invoking: GNU C Compiler').startsWith(ANSI.stage256));
  assert.ok(highlightBuildLine('arm-none-eabi-gcc -c main.c').startsWith(ANSI.command256));
  assert.ok(highlightBuildLine('text data bss dec hex filename').startsWith(ANSI.size256));
  assert.ok(highlightBuildLine(
    'Managed Build system manifest file error: Duplicate identifier ilg.gnuarmeclipse.managedbuild.cross.tool.assembler for element type Tool.'
  ).startsWith(ANSI.white256));
  assert.ok(highlightBuildLine('Managed Build system manifest file error: Invalid extension').startsWith(ANSI.error256));
  assert.equal(highlightBuildLine('Build summary: 0 errors, 0 warnings'), 'Build summary: 0 errors, 0 warnings');
});

test('build log highlighter preserves lines split across process chunks', () => {
  const output = [];
  const highlighter = createBuildLogHighlighter((text) => output.push(text));
  highlighter.write(Buffer.from('main.c:1: warn'));
  assert.deepEqual(output, []);
  highlighter.write(Buffer.from('ing: unused\nnext'));
  highlighter.flush();

  assert.ok(output[0].startsWith(ANSI.warning256));
  assert.ok(output[0].includes(`warning: unused${ANSI.reset}\r\n`));
  assert.equal(output[1], 'next');
});

test('existing ANSI-colored tool output passes through unchanged', () => {
  const colored = '\x1b[31mtool error\x1b[0m';
  assert.equal(highlightBuildLine(colored), colored);
});

test('distinguishes incompatible Managed Build options from common duplicate identifiers', () => {
  assert.equal(isManagedBuildCompatibilityError(
    'Managed Build system manifest file error: Option com.gigadevice.mbs.arm.option.toolChain.path.1 uses a null category that is invalid in its context. The option was ignored.'
  ), true);
  assert.equal(isManagedBuildCompatibilityError(
    'Managed Build system manifest file error: Option com.gigadevice.mbs.arm.option.toolChain.path.1 uses a null categorythat is invalid in its context. The option was ignored.'
  ), true);
  assert.equal(isManagedBuildCompatibilityError(
    'Managed Build system manifest file error: Duplicate identifier ilg.gnuarmeclipse.managedbuild.cross.tool.assembler for element type Tool.'
  ), false);
});
