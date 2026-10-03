import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEmbeddedWorkflowFeature } from '@agimon-ai/workflow-mcp';

import {
  completeWorkflowRunView,
  foldWorkflowProgress,
  type ParsedWorkflowRun,
  parseWorkflowProgress,
  parseWorkflowRunRecord,
  planWorkflowJobs,
  PROGRESS_FILE_NAME,
  resolveWorkflowHome,
  RUN_RECORD_FILE_NAME,
  WORKFLOW_HOME_ENV,
  WORKFLOW_STAGES,
  WORKSPACES_DIR_NAME,
} from '../workflowRuns';

const { parser } = createEmbeddedWorkflowFeature();

export interface ReadWorkflowRunsOptions {
  /** Registry home override, primarily for tests. */
  homeDir?: string;
  /** Admitted session environment used to resolve the registry home. */
  environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Read the durable workflow registry once.
 *
 * The registry is an initial snapshot only. Live delivery belongs to the
 * session lifecycle and is routed through the host-owned direct event bus.
 */
export function readWorkflowRuns(options: ReadWorkflowRunsOptions = {}): ParsedWorkflowRun[] {
  const environment = options.environment;
  const homeDir =
    options.homeDir ??
    resolveWorkflowHome({
      envValue: environment?.[WORKFLOW_HOME_ENV],
      homeDir: os.homedir(),
    });
  const workspacesDir = path.join(homeDir, WORKSPACES_DIR_NAME);
  const recordCache = new Map<string, { size: number; mtimeMs: number; value: ParsedWorkflowRun | undefined }>();
  const progressCache = new Map<
    string,
    { size: number; mtimeMs: number; value: ReturnType<typeof parseWorkflowProgress> }
  >();

  const cachedParse = <T>(
    cache: Map<string, { size: number; mtimeMs: number; value: T }>,
    filePath: string,
    parse: (raw: string) => T,
    empty: T,
  ): T => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cache.delete(filePath);
      return empty;
    }
    const cached = cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      cache.delete(filePath);
      return empty;
    }
    const value = parse(raw);
    cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  };

  const listDir = (directory: string): string[] => {
    try {
      return fs.readdirSync(directory).sort();
    } catch {
      return [];
    }
  };

  const plans = new Map<string, ReturnType<typeof planWorkflowJobs>>();
  const planFor = (workflowPath: string): ReturnType<typeof planWorkflowJobs> => {
    const cached = plans.get(workflowPath);
    if (cached !== undefined) return cached;
    let plan: ReturnType<typeof planWorkflowJobs> = [];
    try {
      const workflow = parser.parseWorkflowFile(workflowPath);
      plan = planWorkflowJobs(workflow, parser.resolveJobOrder(workflow.jobs, null));
    } catch {
      // ponytail: old runs have no definition snapshot. Keep recorded progress when the source is gone.
    }
    plans.set(workflowPath, plan);
    return plan;
  };

  const runs: ParsedWorkflowRun[] = [];
  for (const workspace of listDir(workspacesDir)) {
    for (const stage of WORKFLOW_STAGES) {
      const stageDir = path.join(workspacesDir, workspace, stage);
      for (const runKey of listDir(stageDir)) {
        const runDir = path.join(stageDir, runKey);
        const recordPath = path.join(runDir, RUN_RECORD_FILE_NAME);
        const progressPath = path.join(runDir, PROGRESS_FILE_NAME);
        const parsed = cachedParse(recordCache, recordPath, parseWorkflowRunRecord, undefined);
        if (parsed === undefined) continue;
        const events = cachedParse(progressCache, progressPath, parseWorkflowProgress, []);
        const jobs = foldWorkflowProgress(events, planFor(parsed.view.workflowPath));
        runs.push({ ...parsed, view: completeWorkflowRunView(parsed.view, jobs) });
      }
    }
  }
  return runs;
}
