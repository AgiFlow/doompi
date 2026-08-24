import { expect, test } from '../support/cockpit.ts';
import { removeRunsScope, writeRunStatus } from '../support/subagentRuns.ts';

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
  writeRunStatus('s1', {
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
  await expect(page.getByTestId('tab-subagents-count')).toHaveText('2');

  await page.getByTestId('tab-subagents').click();
  await expect(page).toHaveURL(/\/session\/s1\/subagents$/);
  await expect(page.getByTestId('run-card-run-a')).toHaveAttribute('data-run-state', 'running');
  await expect(page.getByTestId('run-card-run-b')).toHaveAttribute('data-run-state', 'done');
  await expect(page.getByTestId('subagents-tally')).toHaveText('1 running · 1 done · 0 failed');
  await expect(page.getByTestId('run-card-run-b')).toContainText('Total: 1,652 files.');
  await expect(page.getByTestId('run-card-run-a')).toContainText('working: reading the hub adapter');

  await page.getByTestId('run-card-run-a').click();
  await expect(page.getByTestId('run-drawer')).toBeVisible();
  await expect(page.getByTestId('drawer-agent')).toHaveText('reviewer');
  await expect(page.getByTestId('drawer-task')).toContainText('Review the diff before the cut.');
  await page.getByTestId('drawer-close').click();
  await expect(page.getByTestId('run-drawer')).toBeHidden();

  await page.getByTestId('tab-conversation').click();
  await expect(page.getByTestId('timeline-empty')).toBeVisible();
});

test('a run started while watching appears live', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await page.getByTestId('tab-subagents').click();
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
