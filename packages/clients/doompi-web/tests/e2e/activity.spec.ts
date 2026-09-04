import { expect, test } from '../support/cockpit.ts';
import { appendRunnerLog, writeRunnerRecord } from '../support/runnerRuns.ts';
import { writeWorkflowRun } from '../support/workflowRuns.ts';

// The dock's groups are declared by doompi-team, doompi-runner, and
// doompi-workflow, so this suite serves the synced-style bundle the Playwright
// global setup built from those packages' manifests.
test.use({ assets: 'synced' });

const status = (statusKey: string, statusText?: string) => ({
  type: 'extension_ui_request',
  id: `st-${statusKey}-${Math.random()}`,
  method: 'setStatus',
  statusKey,
  ...(statusText === undefined ? {} : { statusText }),
});

const widget = (widgetKey: string) => ({
  type: 'extension_ui_request',
  id: `wg-${widgetKey}`,
  method: 'setWidget',
  widgetKey,
  widgetLines: ['running'],
});

test('keeps the workflow launcher available before any package reports work', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await expect(page.getByTestId('activity-workflows')).toBeVisible();
  await expect(page.getByTestId('activity-workflow-launch')).toBeVisible();
  await expect(page.getByTestId('activity-empty')).toBeHidden();
});

test('lists the groups whose packages report in, each rendered by its own plugin', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-team-agents'));
  cockpit.session.emit(status('doom-runner-runners'));
  cockpit.session.emit(widget('workflow-mcp-progress'));

  await expect(page.getByTestId('activity-agents')).toBeVisible();
  await expect(page.getByTestId('activity-runners')).toBeVisible();
  await expect(page.getByTestId('activity-workflows')).toBeVisible();
  // A group head is a section, not one more row among the items beneath it.
  // The marker and the name are separate elements with a flex gap, so the
  // concatenated text has no space between them.
  await expect(page.getByTestId('activity-runners')).toContainText('#runners');
  // Each plugin's section renders its own empty state in place of the host summary.
  await expect(page.getByTestId('activity-summary-agents')).toHaveText('idle');
  await expect(page.getByTestId('activity-summary-runners')).toHaveText('idle');
  await expect(page.getByTestId('activity-summary-workflows')).toHaveText('idle');
  await expect(page.getByTestId('background-work-notice')).toBeHidden();
});

test('shows Loop lifecycle rows and routes the single manage action through /loops', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const loop = (state: 'starting' | 'running' | 'stopping') =>
    JSON.stringify([
      { instanceId: 'loop-release', label: 'Release watcher', detail: 'every 60s · Check release status', state },
    ]);

  await expect(page.getByTestId('activity-loops')).toHaveCount(0);
  cockpit.session.emit(status('doom-loop-instances', loop('starting')));

  const row = page.getByTestId('activity-loop-loop-release');
  await expect(page.getByTestId('activity-loops')).toBeVisible();
  await expect(row).toContainText('Release watcher');
  await expect(row).toContainText('every 60s · Check release status');
  await expect(row).toHaveAttribute('data-loop-state', 'starting');
  await expect(page.getByTestId('activity-loops-manage')).toHaveCount(1);

  cockpit.session.emit(status('doom-loop-instances', loop('running')));
  await expect(row).toHaveAttribute('data-loop-state', 'running');

  await page.getByTestId('activity-loops-manage').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/loops');

  cockpit.session.emit(status('doom-loop-instances', loop('stopping')));
  await expect(row).toHaveAttribute('data-loop-state', 'stopping');

  cockpit.session.emit(status('doom-loop-instances'));
  await expect(page.getByTestId('activity-loops')).toHaveCount(0);
});

test('keeps bottom-pinned groups visible while ordinary groups scroll', async ({ page, cockpit }) => {
  await page.setViewportSize({ width: 1280, height: 280 });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-team-agents'));
  cockpit.session.emit(status('doom-runner-runners'));
  cockpit.session.emit(widget('workflow-mcp-progress'));
  cockpit.session.emit(status('doom-voice', 'listening'));

  const scroll = page.getByTestId('activity-scroll');
  const pinned = page.getByTestId('activity-pinned');
  await expect(page.getByTestId('activity-voice')).toBeVisible();
  await expect(pinned.getByTestId('activity-voice')).toBeVisible();
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const pinnedTop = await pinned.evaluate((element) => element.getBoundingClientRect().top);
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByTestId('activity-voice')).toBeVisible();
  expect(await pinned.evaluate((element) => element.getBoundingClientRect().top)).toBe(pinnedTop);
});

test('highlights background work and renders its resume notice once the agent settles', async ({ page, cockpit }) => {
  // The dock's busy state is the runner channel's, so the run has to exist.
  writeRunnerRecord(cockpit.runnerStore, 's1', { id: 'runner-web', name: 'web', command: 'pnpm dev' });
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const activityButton = page.getByTestId('mobile-activity-open');
  const notice = page.getByTestId('background-work-notice');

  await expect(page.getByTestId('activity-runners')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('activity-busy')).toHaveText('1 running');
  await expect(activityButton).toHaveAttribute('data-active', 'true');
  await expect(activityButton).toHaveClass(/text-doom-yellow/);

  // While the agent is still working the transcript already shows the work.
  cockpit.session.emit({ type: 'agent_start' });
  await expect(notice).toBeHidden();

  cockpit.session.emit({ type: 'agent_settled' });
  await expect(notice).toHaveText('Background work is still running. The agent will resume when results are ready.');
  await expect.poll(() => notice.evaluate((element) => getComputedStyle(element).position)).toBe('static');
  await expect.poll(() => notice.evaluate((element) => element.parentElement?.lastElementChild === element)).toBe(true);
});

test('shows an active goal without claiming background work is running', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-goal-current', 'active 0s · ship the regression fix'));
  cockpit.session.emit({ type: 'agent_settled' });

  await expect(page.getByTestId('activity-goal')).toBeVisible();
  await expect(page.getByTestId('activity-goal')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('activity-busy')).toBeHidden();
  await expect(page.getByTestId('mobile-activity-open')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('background-work-notice')).toBeHidden();
});

test('the group name opens the owning plugin panel, and is a label where there is none', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-team-agents'));
  cockpit.session.emit(status('doom-runner-runners'));
  await expect(page.getByTestId('activity-keys-runners')).toHaveText('r l');
  await expect(page.getByTestId('activity-open-runners')).toHaveCount(0);

  await page.getByTestId('activity-open-agents').click();
  await expect(page).toHaveURL(/\/session\/s1\/subagents-fleet$/);
});

test('the runners group lists only what is up now, and a row opens its log', async ({ page, cockpit }) => {
  writeRunnerRecord(cockpit.runnerStore, 's1', {
    id: 'runner-api',
    name: 'api',
    command: 'pnpm dev --filter api',
    logText: 'listening on 7433\nGET /health 200\nGET /missing 404\n',
  });
  // A finished run leaves the dock the moment it exits, failure included: the
  // group answers "what is happening", not "what happened".
  writeRunnerRecord(cockpit.runnerStore, 's1', {
    id: 'runner-old',
    name: 'lint',
    command: 'pnpm lint',
    record: {
      state: 'completed',
      exit: { reason: 'completed', code: 1, signal: null, finishedAt: new Date().toISOString() },
    },
  });
  // A runner that has not written anything yet still has to say what it is.
  writeRunnerRecord(cockpit.runnerStore, 's1', { id: 'runner-quiet', name: 'quiet', command: 'pnpm build' });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit(status('doom-runner-runners', 'Runners 1 ●'));

  const row = page.getByTestId('activity-runner-runner-api');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-runner-tone', 'running');
  await expect(row).toContainText('api');
  // A running row shows what the runner is doing, not what it was asked to do:
  // the command never changes, and the last log line is the progress.
  const detail = page.getByTestId('activity-runner-detail-runner-api');
  await expect(detail).toHaveAttribute('data-detail', 'tail');
  await expect(detail).toHaveText('GET /missing 404');

  // The line follows the log, so a row left open keeps up with the run.
  appendRunnerLog(cockpit.runnerStore, 's1', 'runner-api', 'GET /health 200\nPOST /orders 201\n');
  await expect(detail).toHaveText('POST /orders 201');

  // Until the first line lands, the command is what the row has to say.
  const quiet = page.getByTestId('activity-runner-detail-runner-quiet');
  await expect(quiet).toHaveAttribute('data-detail', 'command');
  await expect(quiet).toHaveText('pnpm build');
  await expect(page.getByTestId('activity-runner-runner-old')).toHaveCount(0);
  await expect(page.getByTestId('activity-summary-runners')).toBeHidden();

  const stop = page.getByTestId('activity-runner-stop-runner-api');
  await stop.click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('/runners stop runner-api');
  await expect(stop).toHaveAttribute('data-stopping', 'true');
});

test('a runner row opens its log in a tab, which reads the file over the plugin API', async ({ page, cockpit }) => {
  writeRunnerRecord(cockpit.runnerStore, 's1', {
    id: 'runner-api',
    name: 'api',
    command: 'pnpm dev --filter api',
    logText: 'listening on 7433\nGET /health 200\nGET /missing 404\n',
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit(status('doom-runner-runners', 'Runners 1 ●'));

  await page.getByTestId('activity-runner-runner-api').click();

  const panel = page.getByTestId('runner-log-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('runner-log-name')).toHaveText('api');
  await expect(page.getByTestId('runner-log-state')).toHaveText('running');
  // The lines come from the file on disk, through the hub's plugin API mount.
  await expect(page.getByTestId('runner-log-body')).toContainText('listening on 7433');
  await expect(page.getByTestId('runner-log-body')).toContainText('GET /missing 404');
  await expect(page.getByTestId('runner-log-path')).toContainText('runner-api.log');

  // The composer addresses the session's agent, so a panel that is a view of
  // something else must not carry one: a prompt box under the log would send
  // somewhere the reader is not looking.
  await expect(page.getByTestId('composer-input')).toHaveCount(0);
  await expect(page.getByTestId('axis-model')).toHaveCount(0);

  await page.getByTestId('tab-conversation').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('axis-model')).toBeVisible();
});

test('the log search filters to matching lines and pauses following', async ({ page, cockpit }) => {
  writeRunnerRecord(cockpit.runnerStore, 's1', {
    id: 'runner-api',
    name: 'api',
    command: 'pnpm dev --filter api',
    // Long enough that the two lines of context around a match cannot reach
    // the far end, so a filtered view is visibly different from the tail.
    logText: `listening on 7433\nGET /missing 404\n${Array.from({ length: 12 }, (_, index) => `GET /health 200 #${String(index)}`).join('\n')}\nshutting down\n`,
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit(status('doom-runner-runners', 'Runners 1 ●'));
  await page.getByTestId('activity-runner-runner-api').click();
  await expect(page.getByTestId('runner-log-body')).toContainText('shutting down');

  await page.getByTestId('runner-log-search').fill('missing');
  await expect(page.getByTestId('runner-log-body')).toContainText('GET /missing 404');
  await expect(page.getByTestId('runner-log-body')).not.toContainText('shutting down');
  await expect(page.getByTestId('runner-log-stats')).toContainText('of 15 lines');
  // A filtered view is a snapshot, so following is off while a query is set.
  await expect(page.getByTestId('runner-log-follow')).toBeDisabled();
  await expect(page.getByTestId('runner-log-follow')).toContainText('paused');
});

test('the workflows group lists the session runs and opens one in the workflows tab', async ({ page, cockpit }) => {
  const at = new Date().toISOString();
  writeWorkflowRun(cockpit.workflowHome, {
    workspace: 'default',
    stage: 'running',
    runKey: 'release-hardening',
    record: { env: { PI_SESSION_ID: 's1' }, displayName: 'Release Hardening' },
    progress: [
      { type: 'job', status: 'running', job: 'build', index: 0, total: 2, at },
      { type: 'step', status: 'running', job: 'build', step: 'edit src/routes/token.ts', at },
    ],
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit(widget('workflow-mcp-progress'));

  const row = page.getByTestId('activity-workflow-release-hardening');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-run-tone', 'running');
  await expect(row).toContainText('Release Hardening');
  await expect(row).toContainText('build · edit src/routes/token.ts');
  await expect(page.getByTestId('activity-summary-workflows')).toBeHidden();
  await expect(page.getByTestId('activity-workflows')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('background-work-notice')).toBeVisible();

  await row.click();
  await expect(page).toHaveURL(/\/session\/s1\/workflows-runs$/);
  await expect(page.getByTestId('workflow-picker')).toContainText('Release Hardening');
});

test('the dock can be hidden and brought back', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('activity-close').click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();

  await page.getByTestId('activity-show').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();
});
