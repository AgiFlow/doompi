import { expect, test } from '../support/cockpit.ts';
import { writeRunnerRecord } from '../support/runnerRuns.ts';

// Tool renderers are plugin contributions, so this suite serves the
// synced-style bundle global setup built from every workspace plugin that
// renders a tool (plus the crash fixture): their tools carry web message
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

test('a promoted bash item offers stop and sends the runner stop command', async ({ page, cockpit }) => {
  // The card only offers stop while the runners channel lists the runner as running.
  writeRunnerRecord(cockpit.runnerStore, 's1', { id: 'runner-web', name: 'web', command: 'pnpm dev' });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-6',
    toolName: 'bash',
    args: { command: 'pnpm dev' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-6',
    result: {
      content: [{ type: 'text', text: 'promoted to background runner web' }],
      details: { id: 'runner-web', runner: 'web', promoted: true, logPath: '/tmp/web.log' },
    },
    isError: false,
  });

  const stop = page.getByTestId('tool-result-bash-stop');
  await stop.click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/runners stop runner-web');
  await expect(stop).toHaveAttribute('data-stopping', 'true');
});

test("a bash item opens the run's full log from its header, expanded or not", async ({ page, cockpit }) => {
  writeRunnerRecord(cockpit.runnerStore, 's1', {
    id: 'runner-web',
    name: 'web',
    command: 'pnpm dev',
    logText: 'listening on 7433\nbuilt in 812ms\n',
  });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-7',
    toolName: 'bash',
    args: { command: 'pnpm dev' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-7',
    result: {
      content: [{ type: 'text', text: 'ok' }],
      details: { id: 'runner-web', runner: 'web', promoted: true, logPath: '/tmp/web.log' },
    },
    isError: false,
  });

  // The control sits in the header, so the card never has to be expanded first.
  const open = page.getByTestId('tool-result-bash-open-log');
  await expect(open).toBeVisible();
  await open.click();

  await expect(page.getByTestId('runner-log-panel')).toBeVisible();
  await expect(page.getByTestId('runner-log-name')).toHaveText('web');
  await expect(page.getByTestId('runner-log-body')).toContainText('built in 812ms');
});

test('a throwing renderer falls back to the host item and the rest of the timeline survives', async ({
  page,
  cockpit,
}) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const call = (toolCallId: string, toolName: string, args: Record<string, unknown>): void => {
    cockpit.session.emit({ type: 'tool_execution_start', toolCallId, toolName, args });
    cockpit.session.emit({
      type: 'tool_execution_end',
      toolCallId,
      result: { content: [{ type: 'text', text: `${toolName} output` }] },
      isError: false,
    });
  };
  call('call-7', 'bash', { command: 'echo before' });
  call('call-8', 'crash', { boom: true });
  call('call-9', 'bash', { command: 'echo after' });

  const items = page.getByTestId('entry-tool');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-tool-renderer', 'plugin');
  await expect(items.nth(1)).toHaveAttribute('data-tool-renderer', 'failed');
  await expect(items.nth(1).getByTestId('tool-output')).toContainText('crash output');
  await expect(items.nth(2)).toHaveAttribute('data-tool-renderer', 'plugin');
  await expect(items.nth(2).getByTestId('tool-call-bash')).toContainText('echo after');
});

// One call per migrated tool: the plugin, not the host, renders every item.
const EVERY_TOOL: Array<{ tool: string; args: Record<string, unknown>; details?: unknown }> = [
  { tool: 'bash', args: { command: 'ls' }, details: { tail: 'a', tailLines: 1, exitCode: 0 } },
  { tool: 'read', args: { path: 'src/a.ts' } },
  { tool: 'edit', args: { path: 'src/a.ts', edits: [] }, details: { diff: '-1 a\n+1 b', patch: '' } },
  { tool: 'grep', args: { pattern: 'x', path: '.' } },
  { tool: 'write', args: { path: 'src/b.ts', content: 'x' } },
  { tool: 'find', args: { pattern: '*.ts' } },
  { tool: 'ls', args: { path: '.' } },
  { tool: 'subagent', args: { action: 'run', agent: 'reviewer', task: 'look' } },
  { tool: 'intercom', args: { action: 'list' } },
  { tool: 'task', args: { action: 'list' } },
  { tool: 'ask_user_question', args: { questions: [{ header: 'q', question: 'why?' }] } },
  { tool: 'record_debug_evidence', args: { issue: 'i1', evidence: 'e' } },
  { tool: 'goal_complete', args: { summary: 'done' } },
  { tool: 'describe_voice_tools', args: {} },
  { tool: 'list_workflows', args: {} },
];

test('every migrated tool renders a plugin item, never the host fallback', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  for (const [index, entry] of EVERY_TOOL.entries()) {
    const toolCallId = `sweep-${String(index)}`;
    cockpit.session.emit({ type: 'tool_execution_start', toolCallId, toolName: entry.tool, args: entry.args });
    cockpit.session.emit({
      type: 'tool_execution_end',
      toolCallId,
      result: { content: [{ type: 'text', text: `${entry.tool} output` }], details: entry.details },
      isError: false,
    });
  }

  const items = page.getByTestId('entry-tool');
  await expect(items).toHaveCount(EVERY_TOOL.length);
  for (const [index, entry] of EVERY_TOOL.entries()) {
    await expect(items.nth(index), entry.tool).toHaveAttribute('data-tool-name', entry.tool);
    await expect(items.nth(index), entry.tool).toHaveAttribute('data-tool-renderer', 'plugin');
    await expect(items.nth(index), entry.tool).toHaveAttribute('data-tool-state', 'ok');
  }
});
