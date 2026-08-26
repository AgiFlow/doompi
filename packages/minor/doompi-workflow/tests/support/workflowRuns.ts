import fs from 'node:fs';
import path from 'node:path';
import { PROGRESS_FILE_NAME, RUN_RECORD_FILE_NAME, WORKSPACES_DIR_NAME } from '../../src/services/workflowRuns.ts';
import type { WorkflowStage } from '../../src/types/webWorkflows.ts';

export interface WorkflowRunFixture {
  workspace: string;
  stage: WorkflowStage;
  runKey: string;
  /** Merged over the minimal valid record; pass errorMessage, env, etc. here. */
  record?: Record<string, unknown>;
  /** progress.ndjson lines, one event object per entry; omitted means no log yet. */
  progress?: Record<string, unknown>[];
}

/** The run directory a fixture occupies, mirroring the engine's layout. */
export function workflowRunDir(
  homeDir: string,
  fixture: Pick<WorkflowRunFixture, 'workspace' | 'stage' | 'runKey'>,
): string {
  return path.join(homeDir, WORKSPACES_DIR_NAME, fixture.workspace, fixture.stage, fixture.runKey);
}

/** Writes one run the way workflow-mcp lays it out: run.json plus progress.ndjson. */
export function writeWorkflowRun(homeDir: string, fixture: WorkflowRunFixture): void {
  const runDir = workflowRunDir(homeDir, fixture);
  fs.mkdirSync(runDir, { recursive: true });
  const record = {
    displayName: fixture.runKey,
    dryRun: false,
    runKey: fixture.runKey,
    stage: fixture.stage,
    startedAt: new Date().toISOString(),
    workflowPath: `/workspace/automations/${fixture.runKey}.workflow.yml`,
    workflowName: fixture.runKey,
    workspace: fixture.workspace,
    ...fixture.record,
  };
  fs.writeFileSync(path.join(runDir, RUN_RECORD_FILE_NAME), JSON.stringify(record));
  if (fixture.progress !== undefined) {
    fs.writeFileSync(
      path.join(runDir, PROGRESS_FILE_NAME),
      fixture.progress.map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
  }
}

/** Moves a run between stage buckets and rewrites its recorded stage, the way the registry does. */
export function moveWorkflowRun(
  homeDir: string,
  fixture: Pick<WorkflowRunFixture, 'workspace' | 'runKey'>,
  from: WorkflowStage,
  to: WorkflowStage,
  recordPatch: Record<string, unknown> = {},
): void {
  const fromDir = workflowRunDir(homeDir, { ...fixture, stage: from });
  const toDir = workflowRunDir(homeDir, { ...fixture, stage: to });
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  fs.renameSync(fromDir, toDir);
  const recordPath = path.join(toDir, RUN_RECORD_FILE_NAME);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, stage: to, ...recordPatch }));
}
