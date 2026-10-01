import fs from 'node:fs';

import { expect, test } from '../support/cockpit';
import { moveWorkflowRun, workflowRunDir, writeWorkflowArtifact, writeWorkflowRun } from '../support/workflowRuns';

// The workflow dock face is not in the package's own bundle: it arrives through
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
  await cockpit.session.waitForAttach();
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-dock-run')).toContainText('Release Hardening');
  await expect(page.getByTestId('workflow-dock-state')).toHaveAttribute('data-run-state', 'running');
  await expect(page.getByTestId('workflow-dock-run')).toContainText('build › edit src/routes/token.ts');
  await expect(page.getByTestId('delete-workflow')).toHaveCount(0);

  // The active step leads, and the moving job is open with its steps' states.
  await expect(page.getByTestId('workflow-dock-active-edit src/routes/token.ts')).toBeVisible();
  await expect(page.getByTestId('job-row-research')).toHaveAttribute('data-job-status', 'completed');
  await expect(page.getByTestId('job-row-build')).toHaveAttribute('data-job-status', 'running');
  await expect(page.getByTestId('job-row-build')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('step-row-resolve inputs')).toHaveAttribute('data-step-status', 'completed');
  await expect(page.getByTestId('step-row-edit src/routes/token.ts')).toHaveAttribute('data-active', 'true');
  // A folded job opens on click.
  await page.getByTestId('job-row-research').click();
  await expect(page.getByTestId('step-row-map the risk surface')).toHaveAttribute('data-step-status', 'completed');
  await expect(page.getByTestId('workflow-dock-artifacts')).toBeVisible();

  // The active step opens its own view.
  await page.getByTestId('workflow-dock-active-edit src/routes/token.ts').click();
  await expect(page).toHaveURL(/\/session\/s1\/workflows-step-/);
  await expect(page.getByTestId('step-terminal-panel')).toBeVisible();
});

test('an external recovered running step clears its old conversation and guidance on indexed restart', async ({
  page,
  cockpit,
}) => {
  const at = new Date().toISOString();
  const fixture = { workspace: 'default', stage: 'running' as const, runKey: 'recovered-run' };
  const ref = { kind: 'session', id: 'external-old-session' };
  const progress = [
    { type: 'job', status: 'running', job: 'build', index: 0, total: 1, at },
    { type: 'step', status: 'running', job: 'build', step: 'implement', index: 0, at },
    { type: 'step', status: 'running', job: 'build', step: 'implement', ref, at },
  ];
  writeWorkflowRun(cockpit.workflowHome, { ...fixture, record: OWNED, progress });
  const runningRun = {
    ...fixture,
    displayName: 'Recovered Run',
    workflowName: fixture.runKey,
    workflowPath: `/workspace/automations/${fixture.runKey}.workflow.yml`,
    startedAt: at,
    jobs: [{ name: 'build', phase: 'job', status: 'running', steps: [{ name: 'implement', status: 'running', ref }] }],
  };

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.publishSessionEvent('workflow_runs', 's1', { runs: [runningRun] });
  await page.getByTestId('dock-tab-workflow').click();
  await page.getByTestId('workflow-dock-active-implement').click();
  await expect(page.getByTestId('step-conversation-panel')).toBeVisible();
  await page.getByTestId('step-steer-input').fill('old conversation draft');

  // The interrupted attempt never settled. An indexed start still replaces it.
  const restartedAt = new Date(Date.parse(at) + 1000).toISOString();
  writeWorkflowRun(cockpit.workflowHome, {
    ...fixture,
    record: OWNED,
    progress: [
      ...progress,
      { type: 'step', status: 'running', job: 'build', step: 'implement', index: 0, at: restartedAt },
    ],
  });
  // Live channels carry the folded view, not raw progress events. The parser's
  // indexed-restart contract is covered by workflow unit tests.
  cockpit.publishSessionEvent('workflow_runs', 's1', {
    runs: [
      {
        ...runningRun,
        jobs: [
          {
            name: 'build',
            phase: 'job',
            status: 'running',
            steps: [{ name: 'implement', status: 'running', startedAt: restartedAt }],
          },
        ],
      },
    ],
  });
  await expect(page.getByTestId('step-terminal-panel')).toBeVisible();
  await expect(page.getByTestId('step-conversation-panel')).toHaveCount(0);
  await expect(page.getByTestId('step-steer-composer')).toHaveCount(0);
  await expect(page.getByTestId('step-row-implement')).toHaveAttribute('data-step-status', 'running');
});

test('a terminal workflow with a stale running step retains conversation without offering guidance', async ({
  page,
  cockpit,
}) => {
  const at = new Date().toISOString();
  const fixture = { workspace: 'default', stage: 'error' as const, runKey: 'interrupted-run' };
  const ref = { kind: 'session', id: 'external-settled-session' };
  writeWorkflowRun(cockpit.workflowHome, {
    ...fixture,
    record: { ...OWNED, outcome: 'failed', finishedAt: at },
    progress: [
      { type: 'job', status: 'running', job: 'build', index: 0, total: 1, at },
      { type: 'step', status: 'running', job: 'build', step: 'implement', ref, at },
    ],
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  cockpit.publishSessionEvent('workflow_runs', 's1', {
    runs: [
      {
        ...fixture,
        displayName: 'Interrupted Run',
        workflowName: fixture.runKey,
        workflowPath: `/workspace/automations/${fixture.runKey}.workflow.yml`,
        startedAt: at,
        finishedAt: at,
        outcome: 'failed',
        jobs: [
          { name: 'build', phase: 'job', status: 'running', steps: [{ name: 'implement', status: 'running', ref }] },
        ],
      },
    ],
  });
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-dock-attention')).toBeVisible();
  await expect(page.getByTestId('step-row-implement')).toHaveAttribute('data-step-status', 'running');
  await page.getByTestId('step-row-implement').click();
  await expect(page.getByTestId('step-conversation-panel')).toBeVisible();
  await expect(page.getByTestId('step-terminal-stage')).toHaveText('error');
  await expect(page.getByTestId('step-steer-composer')).toHaveCount(0);
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
  await cockpit.session.waitForAttach();
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-dock-run')).toContainText('Publication');
  await page.getByTestId('artifact-row-publication-checklist.md').click();
  await expect(page.getByTestId('artifact-markdown')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Publication Checklist' })).toBeVisible();
  await page.getByTestId('artifact-raw-toggle').click();
  await expect(page.getByTestId('artifact-raw')).toContainText('# Publication Checklist');
  await page.getByTestId('artifact-rendered-toggle').click();
  await expect(page.getByTestId('artifact-markdown')).toBeVisible();

  await page.getByTestId('dock-tab-workflow').click();
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
  await cockpit.session.waitForAttach();
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-dock-run')).toContainText('Finished Run');
  await page.getByTestId('delete-workflow').click();
  await expect(page.getByTestId('delete-workflow-dialog')).toContainText('Delete Finished Run?');
  await expect(page.getByTestId('delete-workflow-dialog')).toContainText('logs and artifacts');
  await page.getByTestId('delete-workflow-cancel').click();
  await expect(page.getByTestId('delete-workflow-dialog')).toHaveCount(0);
  expect(fs.existsSync(runDir)).toBe(true);

  await page.getByTestId('delete-workflow').click();
  await page.getByTestId('delete-workflow-confirm').click();
  // With no run left the session has nothing for the face to show, so the dock falls back.
  await expect(page.getByTestId('dock-tab-workflow')).toHaveCount(0);
  expect(fs.existsSync(runDir)).toBe(false);
});

test('the dock face appears with the first run and shows a failure live', async ({ page, cockpit }) => {
  const at = new Date().toISOString();
  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();
  await expect(page.getByTestId('dock-tab-workflow')).toHaveCount(0);

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
  const runningRun = {
    runKey: 'dev-fix',
    workspace: 'default',
    displayName: 'Development Fix',
    workflowName: 'dev-fix',
    workflowPath: '/workspace/automations/dev-fix.workflow.yml',
    stage: 'running',
    startedAt: at,
    jobs: [],
  };
  cockpit.publishSessionEvent('workflow_runs', 's1', { runs: [runningRun] });
  // The face selects itself once the session owns a run.
  await expect(page.getByTestId('workflow-dock-run')).toContainText('Development Fix', { timeout: 5000 });

  const finishedAt = new Date().toISOString();
  moveWorkflowRun(cockpit.workflowHome, { workspace: 'default', runKey: 'dev-fix' }, 'running', 'error', {
    outcome: 'failed',
    errorMessage: 'nx test failed: 3 of 41 checks',
    failedJob: 'fix',
    finishedAt,
  });
  cockpit.publishSessionEvent('workflow_runs', 's1', {
    runs: [
      {
        ...runningRun,
        stage: 'error',
        outcome: 'failed',
        errorMessage: 'nx test failed: 3 of 41 checks',
        failedJob: 'fix',
        finishedAt,
      },
    ],
  });

  await expect(page.getByTestId('workflow-dock-attention')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('workflow-dock-attention')).toContainText("job 'fix' failed");
  await expect(page.getByTestId('workflow-dock-attention')).toContainText('nx test failed: 3 of 41 checks');
  await expect(page.getByTestId('workflow-dock-state')).toHaveAttribute('data-run-state', 'failed');
});

test('a workflow owned by another session stays off this dock', async ({ page, cockpit }) => {
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
  await cockpit.session.waitForAttach();
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-dock-run')).toContainText('mine', { timeout: 5000 });
  // One owned run: no picker, and the foreign run is nowhere.
  await expect(page.getByTestId('workflow-picker')).toHaveCount(0);
  await expect(page.getByText('foreign')).toHaveCount(0);
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
  await cockpit.session.waitForAttach();
  await page.getByTestId('dock-tab-workflow').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('30 workflows', { timeout: 5000 });

  await page.getByTestId('workflow-picker').click();
  await page.getByTestId('workflow-picker-search').fill('Workflow 29');
  await expect(page.getByTestId('workflow-option-workflow-29')).toBeVisible();
  await expect(page.getByTestId('workflow-option-workflow-0')).toHaveCount(0);
  await page.getByTestId('workflow-option-workflow-29').click();
  await expect(page.getByTestId('workflow-picker')).toContainText('Workflow 29');
});

test.describe('with a workflow session beside its launcher', () => {
  test.use({ sessionCount: 2 });

  test('a run handed to a workflow session opens that session from the launcher’s Activity row', async ({
    page,
    cockpit,
  }) => {
    await page.goto(cockpit.url);
    await cockpit.session.waitForAttach();
    // The launcher's payload as the hub channel builds it: a run owned by its workflow session.
    // Routing an owner's update to its launcher is covered by the doompi-workflow channel tests.
    cockpit.publishSessionEvent('workflow_runs', 's1', {
      runs: [
        {
          runKey: 'handed',
          workspace: 'default',
          displayName: 'Handed Run',
          workflowPath: '/workspace/automations/handed.workflow.yml',
          stage: 'running',
          startedAt: new Date().toISOString(),
          ownerSessionId: 's2',
          launcherSessionId: 's1',
          jobs: [],
        },
      ],
    });
    // The launcher lists the run but does not own it, so it shows no workflow face of its own.
    await expect(page.getByTestId('activity-workflow-handed')).toHaveAttribute('data-delegated', 'true', {
      timeout: 5000,
    });
    await expect(page.getByTestId('dock-tab-workflow')).toHaveCount(0);
    await page.getByTestId('activity-workflow-handed').click();
    await expect(page).toHaveURL(/\/session\/s2$/);
  });
});
