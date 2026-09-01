import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import {
  WORKFLOW_CATALOG_TYPE,
  type WorkflowCatalogEntryView,
  type WorkflowCatalogPayload,
} from '../types/webWorkflows.ts';

/** One session's catalog: what the hub last reported plus what the drawer is doing with it. */
export interface CatalogSession {
  cwd: string;
  workflows: WorkflowCatalogEntryView[];
  warning: string | undefined;
  /** True while the catalog drawer is shown in the workflows tab. */
  open: boolean;
  filter: string;
  /** The highlighted row, by workflow path. */
  selected: string | undefined;
  /** The row whose parsed detail is unfolded. */
  inspected: string | undefined;
  /** The workflow the launch dialog is open for. */
  launch: string | undefined;
}

export const catalog = defineSessionStore<CatalogSession>({
  cwd: '',
  workflows: [],
  warning: undefined,
  open: false,
  filter: '',
  selected: undefined,
  inspected: undefined,
  launch: undefined,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function openCatalog(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, open: true }));
}

export function closeCatalog(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, open: false, launch: undefined }));
}

export function setCatalogFilter(sessionId: string, filter: string): void {
  catalog.update(sessionId, (current) => ({ ...current, filter }));
}

export function selectWorkflow(sessionId: string, path: string | undefined): void {
  catalog.update(sessionId, (current) => ({ ...current, selected: path }));
}

export function toggleInspect(sessionId: string, path: string): void {
  catalog.update(sessionId, (current) => ({ ...current, inspected: current.inspected === path ? undefined : path }));
}

export function openLaunch(sessionId: string, path: string): void {
  catalog.update(sessionId, (current) => ({ ...current, selected: path, launch: path }));
}

export function closeLaunch(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, launch: undefined }));
}

/** Rows whose name, path, tag or job matches the filter, case-insensitively. */
export function filterCatalog(
  workflows: readonly WorkflowCatalogEntryView[],
  filter: string,
): WorkflowCatalogEntryView[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return [...workflows];
  return workflows.filter((workflow) =>
    [
      workflow.name,
      workflow.relativePath,
      workflow.description,
      ...workflow.tags,
      ...workflow.jobs.map((job) => job.name),
    ]
      .join('\n')
      .toLowerCase()
      .includes(needle),
  );
}

/** The plugin's catalog channel: 'workflow_catalog' payloads into the store. */
export const workflowCatalogChannel = catalog.channel<WorkflowCatalogPayload>({
  channel: WORKFLOW_CATALOG_TYPE,
  parse(input) {
    if (!isRecord(input) || typeof input.cwd !== 'string' || !Array.isArray(input.workflows)) return null;
    return {
      cwd: input.cwd,
      workflows: input.workflows.filter(isRecord) as unknown as WorkflowCatalogEntryView[],
      ...(typeof input.warning === 'string' ? { warning: input.warning } : {}),
    };
  },
  reduce(current, payload) {
    const paths = new Set(payload.workflows.map((workflow) => workflow.path));
    return {
      ...current,
      cwd: payload.cwd,
      workflows: payload.workflows,
      warning: payload.warning,
      // A row that is gone cannot stay selected, inspected, or half-launched.
      selected: current.selected !== undefined && paths.has(current.selected) ? current.selected : undefined,
      inspected: current.inspected !== undefined && paths.has(current.inspected) ? current.inspected : undefined,
      launch: current.launch !== undefined && paths.has(current.launch) ? current.launch : undefined,
    };
  },
});
