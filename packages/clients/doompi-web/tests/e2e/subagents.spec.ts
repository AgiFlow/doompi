import { expect, test } from '../support/cockpit.ts';
import {
  appendRunJournal,
  journalEntry,
  removeRunsScope,
  writeAgentDefinition,
  writeRunJournal,
  writeRunStatus,
} from '../support/subagentRuns.ts';

// The fixture's first session is always 's1'; its doom-team scope is global
// per session id, so every test starts and ends with it clean. That same
// global scope is why this file cannot run its tests in parallel workers:
// they would write into and wipe each other's fleet.
// The subagents tab is doompi-team's plugin now, so this suite serves the
// synced-style bundle the Playwright global setup built.
test.use({ assets: 'synced' });
test.describe.configure({ mode: 'serial' });
test.beforeEach(() => removeRunsScope('s1'));
test.afterEach(() => removeRunsScope('s1'));

test('shows the session fleet in the subagents tab', async ({ page, cockpit }) => {
  const now = Date.now();
  // The card and the sheet both work off the run's own transcript now, so
  // run-a needs a journal and a status that names it.
  const journalA = writeRunJournal('s1', 'run-a', [
    journalEntry('d1', { role: 'user', content: [{ type: 'text', text: 'Review the diff before the cut.' }] }),
    journalEntry('d2', {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the hub adapter first.' },
        { type: 'toolCall', id: 'call-d', name: 'read', arguments: { path: 'src/adapters/sessionHub.ts' } },
      ],
    }),
  ]);
  writeRunStatus('s1', {
    sessionFile: journalA,
    version: 1,
    runId: 'run-a',
    agent: 'reviewer',
    state: 'running',
    startedAt: now - 60_000,
    lastUpdate: now,
    task: 'Review the diff before the cut.',
    cwd: '/workspace/doompi',
    currentTool: 'working: reading the hub adapter',
    toolCount: 3,
  });
  writeRunStatus('s1', {
    version: 1,
    runId: 'run-b',
    agent: 'package-dev',
    state: 'completed',
    startedAt: now - 180_000,
    endedAt: now - 120_000,
    lastUpdate: now - 120_000,
    task: 'Count the markdown files.',
    cwd: '/workspace/doompi',
    summary: 'Total: 1,652 files.',
    toolCount: 4,
    tokens: 85_380,
  });
  await page.goto(cockpit.url);
  await page.getByTestId('activity-open-agents').click();
  await expect(page).toHaveURL(/\/session\/s1\/subagents-fleet$/);
  await expect(page.getByTestId('run-card-run-a')).toHaveAttribute('data-run-state', 'running');
  await expect(page.getByTestId('run-card-run-b')).toHaveAttribute('data-run-state', 'done');
  await expect(page.getByTestId('subagents-tally')).toHaveText('1 running · 1 done · 0 failed');
  // The card body is the run's own conversation, not a flattened tail: the
  // same timeline the main session draws, tool cards and all.
  const cardThread = page.getByTestId('run-card-run-a').getByTestId('thread-timeline');
  await expect(cardThread.getByTestId('entry-assistant')).toContainText('Reading the hub adapter first.');
  await expect(cardThread.getByTestId('entry-tool')).toHaveAttribute('data-tool-name', 'read');

  // Details is in the card's menu, and it opens over the grid rather than
  // beside it.
  await page.getByTestId('run-menu-run-a').click();
  await page.getByTestId('run-detail-run-a').click();
  await expect(page.getByTestId('run-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-agent')).toHaveText('reviewer');
  await expect(page.getByTestId('sheet-task')).toContainText('Review the diff before the cut.');
  await expect(page.getByTestId('run-sheet').getByTestId('thread-timeline')).toHaveCount(0);
  await page.getByTestId('run-sheet').getByLabel('close the run detail').click();
  await expect(page.getByTestId('run-sheet')).toBeHidden();

  // The finished run's report is a sheet fact, not a card one.
  await page.getByTestId('run-menu-run-b').click();
  await page.getByTestId('run-detail-run-b').click();
  await expect(page.getByTestId('sheet-summary')).toContainText('Total: 1,652 files.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('run-sheet')).toBeHidden();

  // The card itself is the way into the run's own thread.
  await page.getByTestId('run-open-card-run-a').click();
  await expect(page).toHaveURL(/\/session\/s1\/subagents-run-run-a$/);
  await expect(page.getByTestId('agent-thread-agent')).toHaveText('reviewer');

  await page.getByTestId('tab-conversation').click();
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
});

test('a run started while watching appears live', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await page.getByTestId('activity-open-agents').click();
  await expect(page.getByTestId('subagents-empty')).toBeVisible();

  writeRunStatus('s1', {
    version: 1,
    runId: 'run-live',
    agent: 'doc-writer',
    state: 'queued',
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    task: 'Draft the notes.',
    cwd: '/workspace/doompi',
  });

  await expect(page.getByTestId('run-card-run-live')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('run-card-run-live')).toHaveAttribute('data-run-state', 'queued');
});

const LONG_TASK =
  'Review the current working tree diff in /Users/vuongngo/workspace/doompi, with special attention to packages/clients/doompi-web. Inspect all modified and untracked files using git diff, git status, and source context. Look for concrete defects, regressions, contract violations, missing edge cases, and test issues.';

test('a long prompt truncates inside the card instead of widening the grid', async ({ page, cockpit }) => {
  const now = Date.now();
  writeRunStatus('s1', {
    version: 1,
    runId: 'run-wide',
    agent: 'doompi-reviewer',
    state: 'running',
    startedAt: now - 60_000,
    lastUpdate: now,
    task: LONG_TASK,
    cwd: '/workspace/doompi',
    currentTool: `working: ${LONG_TASK}`,
  });

  await page.goto(cockpit.url);
  await page.getByTestId('activity-open-agents').click();
  const card = page.getByTestId('run-card-run-wide');
  await expect(card).toBeVisible();

  // The grid template only exists if Tailwind scanned the plugin sources;
  // without it the single auto column grows to the longest line and the
  // panel scrolls sideways.
  const grid = page.getByTestId('subagents-grid');
  await expect(grid).toHaveCSS('grid-template-columns', /px/);
  const [cardBox, gridBox] = await Promise.all([card.boundingBox(), grid.boundingBox()]);
  expect(cardBox).not.toBeNull();
  expect(gridBox).not.toBeNull();
  expect(cardBox!.width).toBeLessThanOrEqual(gridBox!.width + 1);
  const overflows = await page
    .getByTestId('subagents-panel')
    .evaluate((panel) => panel.scrollWidth > panel.clientWidth + 1);
  expect(overflows).toBe(false);
});

test('stop asks the runtime and clear hides a finished run', async ({ page, cockpit }) => {
  const now = Date.now();
  writeRunStatus('s1', {
    version: 1,
    runId: 'run-stop',
    agent: 'reviewer',
    state: 'running',
    startedAt: now - 60_000,
    lastUpdate: now,
    task: 'Review the diff.',
    cwd: '/workspace/doompi',
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await page.getByTestId('activity-open-agents').click();

  await page.getByTestId('run-menu-run-stop').click();
  await page.getByTestId('run-stop-run-stop').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/subagents-stop run-stop');
  // The click is a request; the card waits for the run's own word.
  await page.getByTestId('run-menu-run-stop').click();
  await expect(page.getByTestId('run-stop-run-stop')).toHaveText('stopping…');
  await expect(page.getByTestId('run-stop-run-stop')).toBeDisabled();
  await page.keyboard.press('Escape');
  // Acting through the menu must not open the detail sheet.
  await expect(page.getByTestId('run-sheet')).toBeHidden();

  writeRunStatus('s1', {
    version: 1,
    runId: 'run-stop',
    agent: 'reviewer',
    state: 'stopped',
    startedAt: now - 60_000,
    endedAt: now,
    lastUpdate: now,
    task: 'Review the diff.',
    cwd: '/workspace/doompi',
  });
  await expect(page.getByTestId('run-card-run-stop')).toHaveAttribute('data-run-state', 'stopped', { timeout: 5000 });

  await page.getByTestId('run-menu-run-stop').click();
  await page.getByTestId('run-clear-run-stop').click();
  await expect(page.getByTestId('run-card-run-stop')).toBeHidden();
  await expect(page.getByTestId('subagents-empty')).toBeVisible();
});

test('the activity dock lists the runs and opens one in a temporary agent tab', async ({ page, cockpit }) => {
  const now = Date.now();
  const journal = writeRunJournal('s1', 'run-dock', [
    journalEntry('j1', { role: 'user', content: [{ type: 'text', text: 'Review the diff.' }] }),
    journalEntry('j2', {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the hub adapter first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/adapters/sessionHub.ts' } },
      ],
    }),
  ]);
  writeRunStatus('s1', {
    version: 1,
    runId: 'run-dock',
    agent: 'doompi-reviewer',
    state: 'running',
    startedAt: now - 60_000,
    lastUpdate: now,
    task: 'Review the diff.',
    cwd: '/workspace/doompi',
    currentTool: 'working: reading the hub adapter',
    toolCount: 4,
    sessionFile: journal,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  // The runtime's footer status is what makes the group exist; the plugin
  // section then replaces its one-line summary.
  cockpit.session.emit({
    type: 'extension_ui_request',
    id: 'st-agents',
    method: 'setStatus',
    statusKey: 'doom-team-agents',
    statusText: 'Agents ◑',
  });

  await page.getByTestId('mobile-activity-open').click();
  const row = page.getByTestId('activity-run-run-dock');
  await expect(row).toBeVisible();
  await expect(row).toContainText('doompi-reviewer');
  await expect(row).toContainText('4 tools');
  await expect(row).toContainText('working: reading the hub adapter');
  await expect(page.getByTestId('activity-summary-agents')).toBeHidden();

  // The row opens the run's own conversation as a tab of its own, rendered
  // on the same transcript as the session: gutters, markdown, tool cards.
  await row.click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();
  await expect(page).toHaveURL(/\/session\/s1\/subagents-run-run-dock$/);
  const chip = page.getByTestId('tab-subagents-run-run-dock');
  await expect(chip).toHaveText('doompi-reviewer');
  await expect(page.getByTestId('agent-thread-agent')).toHaveText('doompi-reviewer');
  await expect(page.getByTestId('agent-thread-state')).toHaveText('RUNNING');
  const thread = page.getByTestId('thread-timeline');
  await expect(thread.getByTestId('entry-user')).toContainText('Review the diff.');
  await expect(thread.getByTestId('entry-assistant')).toContainText('Reading the hub adapter first.');
  const tool = thread.getByTestId('entry-tool');
  await expect(tool).toHaveAttribute('data-tool-name', 'read');
  await expect(tool).toHaveAttribute('data-tool-state', 'running');
  await tool.getByTestId('tool-expand').click();
  // The journal grows while the tab is open; the result settles the card.
  appendRunJournal(journal, [
    journalEntry('j3', {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'export function createSessionHub' }],
      isError: false,
    }),
  ]);
  await expect(tool).toHaveAttribute('data-tool-state', 'ok');
  await expect(tool).toContainText('export function createSessionHub');

  // The same run again focuses the open tab rather than opening a second one.
  await page.getByTestId('mobile-activity-open').click();
  await page.getByTestId('activity-run-run-dock').click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();
  await expect(page.getByTestId('tab-subagents-run-run-dock-chip')).toHaveCount(1);
  await page.getByTestId('tab-subagents-run-run-dock-close').click();
  await expect(page).toHaveURL(/\/session\/s1$/);
  await expect(chip).toHaveCount(0);
});

test('the catalog lists the agents the session can launch and launches one through /run', async ({ page, cockpit }) => {
  writeAgentDefinition(cockpit.agentDir, 'reviewer-e2e', 'Reviews a diff for the e2e suite.');

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await page.getByTestId('activity-open-agents').click();
  await page.getByTestId('subagents-launch').click();
  const drawer = page.getByTestId('catalog-drawer');
  await expect(drawer).toBeVisible();
  const row = page.getByTestId('catalog-agent-reviewer-e2e');
  await expect(row).toContainText('Reviews a diff for the e2e suite.');
  await page.getByTestId('catalog-filter').fill('reviewer-e2e');
  await expect(drawer.locator('[role="option"]')).toHaveCount(1);
  await row.click();
  await page.getByTestId('catalog-launch-reviewer-e2e').click();

  await expect(page.getByTestId('launch-dialog')).toBeVisible();
  await expect(page.getByTestId('launch-agent')).toHaveText('reviewer-e2e');
  await page.getByTestId('launch-task').fill('Review the diff.');
  await page.getByTestId('launch-fork').click();
  await expect(page.getByTestId('launch-command')).toHaveText('/run reviewer-e2e Review the diff. --fork');
  await page.getByTestId('launch-submit').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/run reviewer-e2e Review the diff. --fork');
  await expect(page.getByTestId('launch-dialog')).toBeHidden();
  await expect(drawer).toBeHidden();

  // The run the launch produced opens its own tab as soon as the fleet reports it.
  const now = Date.now();
  writeRunStatus('s1', {
    version: 1,
    runId: 'run-launched',
    agent: 'reviewer-e2e',
    state: 'running',
    startedAt: now,
    lastUpdate: now,
    task: 'Review the diff.',
    cwd: '/workspace/doompi',
  });
  await expect(page).toHaveURL(/\/session\/s1\/subagents-run-run-launched$/);
  await expect(page.getByTestId('tab-subagents-run-run-launched')).toHaveText('reviewer-e2e');
  await expect(page.getByTestId('agent-thread-agent')).toHaveText('reviewer-e2e');
});
