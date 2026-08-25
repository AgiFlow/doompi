import { expect, test } from '../support/cockpit.ts';
import { writeRunnerRecord } from '../support/runnerRuns.ts';
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
});

test('says nothing is supervised until a package reports in', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await expect(page.getByTestId('activity-dock')).toBeVisible();
  await expect(page.getByTestId('activity-empty')).toBeVisible();
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
  // Each plugin's section renders its own idle line in place of the host summary.
  await expect(page.getByTestId('activity-summary-agents')).toHaveText('idle');
  await expect(page.getByTestId('activity-summary-runners')).toHaveText('idle');
  await expect(page.getByTestId('activity-summary-workflows')).toHaveText('idle');
});

test('counts the groups whose session summary is busy', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-runner-runners', 'Runners 2 ●'));

  await expect(page.getByTestId('activity-runners')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('activity-busy')).toHaveText('1 running');
});

test('the key chip opens the owning plugin tab, and is a label where there is none', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  cockpit.session.emit(status('doom-team-agents'));
  cockpit.session.emit(status('doom-runner-runners'));
  await expect(page.getByTestId('activity-keys-runners')).toHaveText('r l');
  await expect(page.getByTestId('activity-open-runners')).toHaveCount(0);

  await page.getByTestId('activity-open-agents').click();
  await expect(page).toHaveURL(/\/session\/s1\/subagents$/);
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

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.session.emit(status('doom-runner-runners', 'Runners 1 ●'));

  const row = page.getByTestId('activity-runner-runner-api');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-runner-tone', 'running');
  await expect(row).toContainText('api');
  await expect(row).toContainText('pnpm dev --filter api');
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

  await row.click();
  await expect(page).toHaveURL(/\/session\/s1\/workflows$/);
  await expect(page.getByTestId('workflow-chip-release-hardening')).toHaveAttribute('data-active', 'true');
});

test('the dock can be hidden and brought back', async ({ page, cockpit }) => {
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  await page.getByTestId('activity-close').click();
  await expect(page.getByTestId('activity-dock')).toBeHidden();

  await page.getByTestId('activity-show').click();
  await expect(page.getByTestId('activity-dock')).toBeVisible();
});
