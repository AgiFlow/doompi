import fs from 'node:fs';
import { expect, test } from '../support/cockpit.ts';
import { moveWorkflowRun, workflowRunDir, writeWorkflowArtifact, writeWorkflowRun } from '../support/workflowRuns.ts';

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
  await expect(page.getByTestId('workflow-picker')).toContainText('Release Hardening');
  await page.getByTestId('workflow-picker').click();
  await expect(page.getByTestId('workflow-option-release-hardening')).toHaveAttribute('data-run-stage', 'running');
  await page.keyboard.press('Escape');

  // The active job is preselected; its steps render with their states.
  await expect(page.getByTestId('job-row-research')).toHaveAttribute('data-job-status', 'completed');
  await expect(page.getByTestId('job-row-build')).toHaveAttribute('data-job-status', 'running');
  await expect(page.getByTestId('job-pane-name')).toHaveText('build');
  await expect(page.getByTestId('step-row-resolve inputs')).toHaveAttribute('data-step-status', 'completed');
  await expect(page.getByTestId('step-row-edit src/routes/token.ts')).toHaveAttribute('data-step-status', 'running');
  await expect(page.getByTestId('step-row-edit src/routes/token.ts')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('workflow-inline-output')).toBeVisible();
  await expect(page.getByTestId('delete-workflow')).toHaveCount(0);
  // Selecting another job swaps the step pane.
  await page.getByTestId('job-row-research').click();
  await expect(page.getByTestId('job-pane-name')).toHaveText('research');
  await expect(page.getByTestId('step-row-map the risk surface')).toHaveAttribute('data-step-status', 'completed');

  // Artifacts replace the dominant detail without moving the compact navigator.
  await page.getByTestId('pane-tab-artifacts').click();
  await expect(page.getByTestId('artifacts-pane')).toBeVisible();
  await expect(page.getByTestId('jobs-pane')).toBeVisible();
});

test('renders Markdown artifacts and explains when an artifact is empty', async ({ page, cockpit }) => {
  const fixture = { workspace: 'default', stage: 'completed' as const, runKey: 'publication' };
  writeWorkflowRun(cockpit.workflowHome, {
    ...fixture,
    record: {
      ...OWNED,
      displayName: 'Publication',
      outcome: 'success',
      finishedAt: new Date().toISOString(),
      runDirectory: {
        description: 'Publication files.',
        entries: [
          {
            path: 'publication-checklist.md',
            kind: 'file',
            description: 'Review checklist.',
            'produced-by': ['review'],
          },
          {
            path: 'copy-review.md',
            kind: 'file',
            description: 'Copy review.',
            'produced-by': ['review'],
          },
        ],
      },
    },
  });
  writeWorkflowArtifact(
    cockpit.workflowHome,
    fixture,
    'publication-checklist.md',
    '# Publication Checklist\n\n- [x] **Ready for review**',
  );
  writeWorkflowArtifact(cockpit.workflowHome, fixture, 'copy-review.md', '');
  await page.goto(cockpit.url);
  await page.getByTestId('tab-workflows').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('Publication');
  await page.getByTestId('pane-tab-artifacts').click();
  await page.getByTestId('artifact-row-publication-checklist.md').click();
  await expect(page.getByTestId('artifact-markdown')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Publication Checklist' })).toBeVisible();
  await page.getByTestId('artifact-raw-toggle').click();
  await expect(page.getByTestId('artifact-raw')).toContainText('# Publication Checklist');
  await page.getByTestId('artifact-rendered-toggle').click();
  await expect(page.getByTestId('artifact-markdown')).toBeVisible();

  await page.getByTestId('tab-workflows').click();
  await page.getByTestId('pane-tab-artifacts').click();
  await page.getByTestId('artifact-row-copy-review.md').click();
  await expect(page.getByTestId('artifact-empty')).toContainText('this artifact is empty');
  await expect(page.getByTestId('artifact-empty')).toContainText('did not write any content');
});

test('confirms before permanently deleting a settled workflow', async ({ page, cockpit }) => {
  const fixture = { workspace: 'default', stage: 'completed' as const, runKey: 'finished-run' };
  writeWorkflowRun(cockpit.workflowHome, {
    ...fixture,
    record: { ...OWNED, displayName: 'Finished Run', outcome: 'success', finishedAt: new Date().toISOString() },
  });
  writeWorkflowArtifact(cockpit.workflowHome, fixture, 'result.md', 'valuable output');
  const runDir = workflowRunDir(cockpit.workflowHome, fixture);

  await page.goto(cockpit.url);
  await page.getByTestId('tab-workflows').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('Finished Run');
  await page.getByTestId('delete-workflow').click();
  await expect(page.getByTestId('delete-workflow-dialog')).toContainText('Delete Finished Run?');
  await expect(page.getByTestId('delete-workflow-dialog')).toContainText('logs and artifacts');
  await page.getByTestId('delete-workflow-cancel').click();
  await expect(page.getByTestId('delete-workflow-dialog')).toHaveCount(0);
  expect(fs.existsSync(runDir)).toBe(true);

  await page.getByTestId('delete-workflow').click();
  await page.getByTestId('delete-workflow-confirm').click();
  await expect(page.getByTestId('workflows-empty')).toBeVisible();
  expect(fs.existsSync(runDir)).toBe(false);
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
  await expect(page.getByTestId('workflow-picker')).toContainText('Development Fix', { timeout: 5000 });

  moveWorkflowRun(cockpit.workflowHome, { workspace: 'default', runKey: 'dev-fix' }, 'running', 'error', {
    outcome: 'failed',
    errorMessage: 'nx test failed: 3 of 41 checks',
    failedJob: 'fix',
    finishedAt: new Date().toISOString(),
  });

  await expect(page.getByTestId('workflow-needs-you')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('needs-card-dev-fix')).toContainText("job 'fix' failed");
  await expect(page.getByTestId('needs-card-dev-fix')).toContainText('nx test failed: 3 of 41 checks');
  await page.getByTestId('workflow-picker').click();
  await expect(page.getByTestId('workflow-option-dev-fix')).toHaveAttribute('data-run-stage', 'error');
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
  await expect(page.getByTestId('workflow-picker')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('workflow-picker').click();
  await expect(page.getByTestId('workflow-option-mine')).toBeVisible();
  await expect(page.getByTestId('workflow-option-foreign')).toHaveCount(0);
});

test('searches thirty runs without turning them into a chip strip', async ({ page, cockpit }) => {
  const finishedAt = new Date().toISOString();
  for (let index = 0; index < 30; index += 1) {
    const running = index >= 20;
    writeWorkflowRun(cockpit.workflowHome, {
      workspace: 'default',
      stage: running ? 'running' : 'completed',
      runKey: `workflow-${String(index)}`,
      record: {
        ...OWNED,
        displayName: `Workflow ${String(index)}`,
        ...(running ? {} : { outcome: 'success', finishedAt }),
      },
    });
  }

  await page.goto(cockpit.url);
  await page.getByTestId('tab-workflows').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('30 workflows', { timeout: 5000 });

  await page.getByTestId('workflow-picker').click();
  await page.getByTestId('workflow-picker-search').fill('Workflow 29');
  await expect(page.getByTestId('workflow-option-workflow-29')).toBeVisible();
  await expect(page.getByTestId('workflow-option-workflow-0')).toHaveCount(0);
  await page.getByTestId('workflow-option-workflow-29').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('Workflow 29');
});
