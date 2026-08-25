import { expect, test } from '../support/cockpit.ts';
import { moveWorkflowRun, writeWorkflowRun } from '../support/workflowRuns.ts';

// The workflows tab is not in the package's own bundle: it arrives through
// the doompi sync path, so this suite serves the synced-style bundle the
// Playwright global setup built from doompi-workflow's manifest.
test.use({ assets: 'synced' });

// Runs are tied to the fixture's first session ('s1') the way doompi-workflow
// ties them: the PI_SESSION_ID the launcher stamped into the record's env.
const OWNED = { env: { PI_SESSION_ID: 's1' } };

test('shows a running workflow with its jobs, steps, and breadcrumb', async ({ page, cockpit }) => {
  const at = new Date().toISOString();
  writeWorkflowRun(cockpit.workflowHome, {
    workspace: 'default',
    stage: 'running',
    runKey: 'release-hardening',
    record: { ...OWNED, displayName: 'Release Hardening', workflowName: 'Release Hardening' },
    progress: [
      { type: 'job', status: 'running', job: 'research', index: 0, total: 3, at },
      { type: 'step', status: 'running', job: 'research', step: 'map the risk surface', at },
      { type: 'step', status: 'completed', job: 'research', step: 'map the risk surface', at },
      { type: 'job', status: 'completed', job: 'research', at },
      { type: 'job', status: 'running', job: 'build', index: 1, total: 3, at },
      { type: 'step', status: 'completed', job: 'build', step: 'resolve inputs', at },
      { type: 'step', status: 'running', job: 'build', step: 'edit src/routes/token.ts', at },
    ],
  });

  await page.goto(cockpit.url);
  await expect(page.getByTestId('tab-workflows-count')).toHaveText('1');

  await page.getByTestId('tab-workflows').click();
  await expect(page).toHaveURL(/\/session\/s1\/workflows$/);
  await expect(page.getByTestId('workflow-chip-release-hardening')).toHaveAttribute('data-run-stage', 'running');
  await expect(page.getByTestId('workflow-now')).toContainText('Release Hardening');
  await expect(page.getByTestId('workflow-now')).toContainText('build');
  await expect(page.getByTestId('workflow-now')).toContainText('edit src/routes/token.ts');
  await expect(page.getByTestId('workflow-attention-tally')).toHaveText('nothing needs you');

  // The active job is preselected; its steps render with their states.
  await expect(page.getByTestId('job-row-research')).toHaveAttribute('data-job-status', 'completed');
  await expect(page.getByTestId('job-row-build')).toHaveAttribute('data-job-status', 'running');
  await expect(page.getByTestId('job-pane-name')).toHaveText('build');
  await expect(page.getByTestId('step-row-resolve inputs')).toHaveAttribute('data-step-status', 'completed');
  await expect(page.getByTestId('step-row-edit src/routes/token.ts')).toHaveAttribute('data-step-status', 'running');

  // Selecting another job swaps the step pane.
  await page.getByTestId('job-row-research').click();
  await expect(page.getByTestId('job-pane-name')).toHaveText('research');
  await expect(page.getByTestId('step-row-map the risk surface')).toHaveAttribute('data-step-status', 'completed');
});

test('a failure moves into the needs-you strip live', async ({ page, cockpit }) => {
  const at = new Date().toISOString();
  await page.goto(cockpit.url);
  await page.getByTestId('tab-workflows').click();
  await expect(page.getByTestId('workflows-empty')).toBeVisible();

  writeWorkflowRun(cockpit.workflowHome, {
    workspace: 'default',
    stage: 'running',
    runKey: 'dev-fix',
    record: { ...OWNED, displayName: 'Development Fix' },
    progress: [
      { type: 'job', status: 'running', job: 'fix', index: 0, total: 1, at },
      { type: 'step', status: 'running', job: 'fix', step: 'implement the fix', at },
    ],
  });
  await expect(page.getByTestId('workflow-chip-dev-fix')).toBeVisible({ timeout: 5000 });

  moveWorkflowRun(cockpit.workflowHome, { workspace: 'default', runKey: 'dev-fix' }, 'running', 'error', {
    outcome: 'failed',
    errorMessage: 'nx test failed: 3 of 41 checks',
    failedJob: 'fix',
    finishedAt: new Date().toISOString(),
  });

  await expect(page.getByTestId('workflow-needs-you')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('needs-card-dev-fix')).toContainText("job 'fix' failed");
  await expect(page.getByTestId('needs-card-dev-fix')).toContainText('nx test failed: 3 of 41 checks');
  await expect(page.getByTestId('workflow-attention-tally')).toHaveText('1 need you');
  await expect(page.getByTestId('workflow-chip-dev-fix')).toHaveAttribute('data-run-stage', 'error');
});

test('a workflow owned by another session stays off this tab', async ({ page, cockpit }) => {
  writeWorkflowRun(cockpit.workflowHome, {
    workspace: 'default',
    stage: 'running',
    runKey: 'foreign',
    record: { env: { PI_SESSION_ID: 'someone-else' }, workflowPath: '/elsewhere/wf.workflow.yml' },
  });
  writeWorkflowRun(cockpit.workflowHome, {
    workspace: 'default',
    stage: 'running',
    runKey: 'mine',
    record: OWNED,
  });

  await page.goto(cockpit.url);
  await page.getByTestId('tab-workflows').click();
  await expect(page.getByTestId('workflow-chip-mine')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('workflow-chip-foreign')).toHaveCount(0);
});
