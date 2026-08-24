import { expect, test } from '../support/cockpit.ts';

// Tool renderers are plugin contributions, so this suite serves the
// synced-style bundle global setup built from doompi-team, doompi-runner,
// doompi-workflow, doompi-read and doompi-edit: their tools carry web
// renderers, the way their TUI halves carry renderCall and renderResult.
test.use({ assets: 'synced' });

test('a plugin renders the call and result of the tool it owns', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'pnpm nx test doompi' },
  });

  const card = page.getByTestId('entry-tool');
  await expect(card).toHaveAttribute('data-tool-renderer', 'plugin');
  await expect(card).toHaveAttribute('data-tool-state', 'running');
  await expect(page.getByTestId('tool-call-bash')).toContainText('pnpm nx test doompi');

  cockpit.session.emit({
    type: 'tool_execution_update',
    toolCallId: 'call-1',
    partialResult: { content: [{ type: 'text', text: 'running 4 tests' }] },
  });
  await expect(page.getByTestId('tool-result-bash')).toContainText('running 4 tests');

  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    // A finished bash result carries its log tail in the details, which is
    // what the TUI's renderBashResult shows; the content text is the model's.
    result: {
      content: [{ type: 'text', text: 'Tests 11 passed (11)' }],
      details: { tail: 'Tests 11 passed (11)', tailLines: 1, exitCode: 0 },
    },
    isError: false,
  });
  await expect(card).toHaveAttribute('data-tool-state', 'ok');
  await expect(page.getByTestId('tool-result-bash')).toContainText('11 passed');
});

test('the host card still renders a tool no plugin claims', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-2',
    toolName: 'mystery',
    args: { query: 'anything' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-2',
    result: { content: [{ type: 'text', text: 'plain text' }] },
    isError: false,
  });

  const card = page.getByTestId('entry-tool');
  await expect(card).toHaveAttribute('data-tool-renderer', 'host');
  await expect(card).toContainText('anything');
  await expect(page.getByTestId('tool-output')).toContainText('plain text');
});

test('the expand toggle hands the plugin renderer its expanded state', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-3',
    toolName: 'bash',
    args: { command: 'seq 30' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-3',
    result: { content: [{ type: 'text', text: lines }], details: { tail: lines, tailLines: 30, exitCode: 0 } },
    isError: false,
  });

  // Collapsed, the bash card keeps the tail end of the log, as the TUI does.
  const result = page.getByTestId('tool-result-bash');
  await expect(result).toContainText('line 30');
  await expect(result).not.toContainText(/\bline 1\b/);
  await page.getByTestId('tool-expand').click();
  await expect(result).toContainText(/\bline 1\b/);
});

test('the read plugin renders a hashline body with line anchors', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-4',
    toolName: 'read',
    args: { path: 'src/a.ts', offset: 3, limit: 2 },
  });
  await expect(page.getByTestId('tool-call-read')).toContainText('src/a.ts');
  await expect(page.getByTestId('tool-call-read')).toContainText('from 3');

  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-4',
    result: { content: [{ type: 'text', text: '3#abc|const x = 1;\n4#def|export { x };\n' }] },
    isError: false,
  });
  const result = page.getByTestId('tool-result-read');
  await expect(result).toContainText('const x = 1;');
  await expect(result).toContainText('export { x };');
  await expect(result).not.toContainText('#abc|');
});

test('the edit plugin renders the diff its result details carry', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-5',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [{ anchor: '3#abc', content: 'const x = 2;' }] },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-5',
    result: {
      content: [{ type: 'text', text: 'ok' }],
      details: { diff: '-3 const x = 1;\n+3 const x = 2;', patch: '' },
    },
    isError: false,
  });
  const result = page.getByTestId('tool-result-edit');
  await expect(result).toContainText('const x = 1;');
  await expect(result).toContainText('const x = 2;');
  await expect(page.getByTestId('entry-tool')).toHaveAttribute('data-tool-renderer', 'plugin');
});
