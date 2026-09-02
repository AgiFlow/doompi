import { expect, test } from '../support/cockpit.ts';
import { writeRunnerRecord } from '../support/runnerRuns.ts';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
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
  // The bash card is a header row until it is opened, so the streamed tail
  // only exists once the item is expanded.
  await expect(page.getByTestId('tool-result-bash')).toHaveCount(0);
  await page.getByTestId('tool-expand').click();
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

test('the host card renders text and safe file previews for a tool no plugin claims', async ({ page, cockpit }) => {
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
    result: {
      content: [
        { type: 'text', text: 'plain text' },
        { type: 'image', data: ONE_PIXEL_PNG, mimeType: 'image/png' },
      ],
      details: {
        blocks: [
          { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav', name: 'sample.wav' },
          { type: 'video', data: 'AAAA', mimeType: 'video/mp4', name: 'clip.mp4' },
          { type: 'resource', uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' },
          { type: 'resource', uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'attached notes' },
          { type: 'file', data: 'UEsDBA==', mimeType: 'application/zip', name: 'archive.zip' },
        ],
      },
    },
    isError: false,
  });

  const card = page.getByTestId('entry-tool');
  await expect(card).toHaveAttribute('data-tool-renderer', 'host');
  await expect(card).toContainText('anything');
  await expect(page.getByTestId('tool-output')).toContainText('plain text');
  await expect(page.getByTestId('tool-output-image')).toBeVisible();
  await expect(page.getByTestId('tool-output-image')).toHaveAttribute('src', `data:image/png;base64,${ONE_PIXEL_PNG}`);
  await expect(page.getByTestId('tool-output-audio')).toBeVisible();
  await expect(page.getByTestId('tool-output-video')).toBeVisible();
  await expect(page.getByTestId('tool-output-pdf')).toBeVisible();
  await expect(page.getByTestId('tool-output-text-file')).toContainText('attached notes');
  await expect(page.getByTestId('tool-output-file')).toContainText('archive.zip');
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

  // Collapsed, the bash card is header only; expanding it shows the command as
  // it was run and the whole tail the frame carried.
  await expect(page.getByTestId('tool-result-bash')).toHaveCount(0);
  await page.getByTestId('tool-expand').click();
  const output = page.getByTestId('tool-result-bash-output');
  await expect(page.getByTestId('tool-result-bash-command')).toContainText('seq 30');
  await expect(output).toContainText(/\bline 1\b/);
  await expect(output).toContainText('line 30');
});

test('the read plugin renders anchored text and attached images', async ({ page, cockpit }) => {
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
    result: {
      content: [
        { type: 'text', text: '3#abc|const x = 1;\n4#def|export { x };\n' },
        { type: 'image', data: ONE_PIXEL_PNG, mimeType: 'image/png' },
      ],
    },
    isError: false,
  });
  const result = page.getByTestId('tool-result-read');
  await expect(result).toContainText('const x = 1;');
  await expect(result).toContainText('export { x };');
  await expect(result).not.toContainText('#abc|');
  await expect(page.getByTestId('tool-result-read-image')).toBeVisible();
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

test('keeps long plan evidence metadata inside its tool header', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'plan-evidence',
    toolName: 'record_debug_evidence',
    args: {
      logs: ['one', 'two'],
      correlatedTraceEvidence: ['one', 'two', 'three', 'four', 'five'],
      timestamps: ['one'],
      verifiedFacts: ['one', 'two', 'three', 'four', 'five', 'six'],
      hypotheses: ['one', 'two'],
      unavailableEvidence: ['one', 'two'],
    },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'plan-evidence',
    result: { content: [{ type: 'text', text: 'ok' }], details: { recorded: true } },
    isError: false,
  });

  const card = page.getByTestId('entry-tool');
  const summary = page.getByTestId('tool-call-record_debug_evidence');
  await expect(card.locator('[data-slot="message-item-header"]')).toContainText('record evidence');
  await expect(card.locator('[data-slot="message-item-header"]')).not.toContainText('record_debug_evidence');
  await expect(summary).toHaveCSS('text-overflow', 'ellipsis');
  await expect(summary).toHaveCSS('overflow', 'hidden');
  await expect(card.getByTestId('tool-status')).toBeVisible();
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

test('code results wear the editor grammar and log output keeps its own colours', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const source = ['// a comment', 'const x = 1;'].join('\n');
  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'hl-read',
    toolName: 'read',
    args: { path: 'src/a.ts' },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'hl-read',
    result: { content: [{ type: 'text', text: '1#abc|// a comment\n2#abd|const x = 1;' }] },
    isError: false,
  });

  // The grammar loads in its own chunk, so the plain text paints first and the
  // colours arrive after; the palette is the editor's, named as theme tokens.
  const comment = page.locator('[data-testid="tool-result-read"] span[style*="--doom-faint"]');
  await expect(comment).toHaveText('// a comment');

  // A runner's log keeps the colours the command wrote, so the card renders
  // them instead of printing the escape sequences as text.
  const ESC = '\u001B[';
  const tail = `${ESC}31mError:${ESC}39m no such flag`;
  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'hl-bash',
    toolName: 'bash',
    args: { command: `echo ${source.length}` },
  });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'hl-bash',
    result: { content: [{ type: 'text', text: tail }], details: { tail, tailLines: 1, exitCode: 0 } },
    isError: false,
  });
  await page.getByTestId('tool-expand').last().click();
  await expect(page.locator('[data-testid="tool-result-bash-output"] span.text-doom-red')).toHaveText('Error:');
  await expect(page.getByTestId('tool-result-bash-output')).not.toContainText('[31m');
});

test('a run of calls to one tool shares a frame, and a lone call keeps its card', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const call = (id: string, command: string, isError = false): void => {
    cockpit.session.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command } });
    cockpit.session.emit({
      type: 'tool_execution_end',
      toolCallId: id,
      result: {
        content: [{ type: 'text', text: 'done' }],
        details: { tail: 'done', tailLines: 1, exitCode: isError ? 1 : 0 },
      },
      isError,
    });
  };
  call('grp-1', 'pnpm lint');
  call('grp-2', 'pnpm typecheck', true);
  call('grp-3', 'pnpm test');

  // One frame for the run, and the run reports the worst thing in it.
  const group = page.getByTestId('entry-tool-group');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-tool-count', '3');
  await expect(group).toContainText('3 calls');
  await expect(group.getByTestId('entry-tool')).toHaveCount(3);

  // A row inside the group drops the tool name the group already states, and
  // stays quiet unless its own outcome differs from the run's.
  await expect(group.getByTestId('tool-status')).toHaveCount(1);
  await expect(group.getByTestId('tool-status')).toHaveText('ERROR');
  await expect(group.getByTestId('entry-tool').first()).not.toContainText('bash');

  // Each row still opens on its own.
  await group.getByTestId('tool-expand').first().click();
  await expect(group.getByTestId('tool-result-bash-command').first()).toContainText('pnpm lint');

  // Anything between two calls ends the run, and a single call is still a card.
  cockpit.session.emit({ type: 'tool_execution_start', toolCallId: 'solo', toolName: 'read', args: { path: 'a.ts' } });
  cockpit.session.emit({
    type: 'tool_execution_end',
    toolCallId: 'solo',
    result: { content: [{ type: 'text', text: '1#abc|const x = 1;' }] },
    isError: false,
  });
  await expect(page.getByTestId('entry-tool-group')).toHaveCount(1);
  await expect(page.getByTestId('entry-tool')).toHaveCount(4);
});

/**
 * The path in a call header is the shortest way to the file itself.
 *
 * A read is the case that has to work without the file-edit timeline: the
 * session never changed this file, so the only thing that can open it is the
 * preview route, bounded by the working directory. What this suite proves is
 * the click and the tab it raises. It cannot prove what the tab then shows,
 * because the fixture's session API socket serves the runner route and nothing
 * else, so the preview request has no route to reach; the route itself is
 * covered against a real filesystem in doompi-file-edit's own tests.
 */
test('a read call opens its file from the path in the header', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit({
    type: 'tool_execution_start',
    toolCallId: 'call-link',
    toolName: 'read',
    args: { path: 'src/Unchanged.ts' },
  });

  await page.getByTestId('tool-call-read').getByTestId('tool-path').click();
  await expect(page.getByTestId('files-preview-panel')).toBeVisible();
  await expect(page.getByTestId('files-preview-breadcrumb')).toContainText('src/Unchanged.ts');
  // The tab is the file's own, not the changed-file tab, which this file has no
  // history for.
  await expect(page).toHaveURL(/\/files-file-[^/]+-preview$/u);
});
