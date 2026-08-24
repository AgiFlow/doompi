import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/**
 * The cockpit half of src/tui/workflow/workflowToolRender.ts: the same
 * result shapes reduced to a list of toned lines, so the React cards stay a
 * thin mapping and the parsing is testable without a DOM. Kept in step with
 * the TUI by hand; the two share no code because web/ may not import src/tui.
 */

export type WorkflowToolName = 'launch_workflow' | 'list_workflows' | 'workflow_run';

export type LineTone = 'hi' | 'text' | 'dim' | 'muted' | 'success' | 'error' | 'warning' | 'accent';

export interface ToolLine {
  text: string;
  tone: LineTone;
  bold?: boolean;
  indent?: boolean;
}

export interface WorkflowCallSummary {
  action: string;
  target?: string;
  metadata: string[];
}

export interface WorkflowRenderOptions {
  expanded: boolean;
  isError: boolean;
  isPartial: boolean;
}

type JsonRecord = Record<string, unknown>;

interface WorkflowState {
  tone: LineTone;
  glyph: string;
  label: string;
}

interface WorkflowCatalogItem {
  description: string;
  name: string;
  path: string;
  tags: string[];
}

interface WorkflowCatalog {
  directory?: string;
  page: number;
  pageSize: number;
  tags: Array<{ count: number; tag: string }>;
  total: number;
  totalPages: number;
  workflows: WorkflowCatalogItem[];
}

interface EvidenceSection {
  body: string[];
  name: string;
}

const COLLAPSED_CATALOG_ROWS = 6;
const COLLAPSED_DETAIL_LINES = 8;
const PARTIAL_DETAIL_LINES = 4;

export const WORKFLOW_TOOL_NAMES: readonly WorkflowToolName[] = ['list_workflows', 'launch_workflow', 'workflow_run'];

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function inlineText(value: string): string {
  let normalized = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    normalized += code <= 31 || code === 127 ? ' ' : character;
  }
  return normalized.replace(/\s+/gu, ' ').trim();
}

function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== 'string') return undefined;
  return inlineText(value) || undefined;
}

function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(record: JsonRecord | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseJsonRecord(text: string | undefined): JsonRecord | undefined {
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    // Not every workflow result is JSON; the plain-text shapes fall through.
    return undefined;
  }
}

function textBlocks(result: ToolResultView | null): string[] {
  if (!result) return [];
  return result.content.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
}

function detailLines(result: ToolResultView | null): string[] {
  return textBlocks(result)
    .flatMap((block) => block.split('\n'))
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);
}

function firstPayload(result: ToolResultView | null): JsonRecord | undefined {
  return parseJsonRecord(textBlocks(result)[0]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function line(text: string, tone: LineTone, extra: Omit<ToolLine, 'text' | 'tone'> = {}): ToolLine {
  return { text, tone, ...extra };
}

function labelValue(label: string, value: string): ToolLine {
  return line(`${label} ${value}`, 'text');
}

function hiddenLine(hidden: number): ToolLine {
  return line(`… ${hidden} more`, 'dim');
}

function targetScope(args: JsonRecord): string | undefined {
  const runKey = readString(args, 'runKey');
  if (!runKey) return undefined;
  const workspace = readString(args, 'workspace');
  return workspace ? `${workspace}/${runKey}` : runKey;
}

function toolAction(toolName: WorkflowToolName, args: JsonRecord): string {
  if (toolName === 'list_workflows') return 'list';
  if (toolName === 'launch_workflow') return 'launch';
  return readString(args, 'action') ?? 'run';
}

function toolTarget(toolName: WorkflowToolName, args: JsonRecord): string | undefined {
  if (toolName === 'list_workflows') return readString(args, 'directory');
  if (toolName === 'launch_workflow') return readString(args, 'workflowPath');
  return targetScope(args);
}

function statusTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function workflowNameFromPath(path: string | undefined): string {
  if (!path) return 'workflow';
  const filename = path.split('/').at(-1) ?? path;
  return filename.replace(/\.workflow\.ya?ml$/u, '') || filename;
}

function callMetadata(toolName: WorkflowToolName, args: JsonRecord): string[] {
  const values: string[] = [];

  if (toolName === 'list_workflows') {
    const page = readNumber(args, 'page');
    const pageSize = readNumber(args, 'pageSize');
    if (page !== undefined) values.push(`page ${page}`);
    if (pageSize !== undefined) values.push(`${pageSize}/page`);
    if (readString(args, 'filter')) values.push('filtered');
    const tags = readStringArray(args, 'tags');
    if (tags.length > 0) values.push(`${tags.length} ${plural(tags.length, 'tag')}`);
  } else if (toolName === 'launch_workflow') {
    const job = readString(args, 'job');
    const runner = readString(args, 'runner');
    const workspace = readString(args, 'workspace');
    const inputCount = Object.keys(asRecord(args.inputs) ?? {}).length;
    const environmentCount = Object.keys(asRecord(args.env) ?? {}).length;
    if (workspace) values.push(`workspace ${workspace}`);
    if (job) values.push(`job ${job}`);
    if (runner) values.push(`runner ${runner}`);
    if (readBoolean(args, 'dryRun')) values.push('dry run');
    if (readString(args, 'prompt')) values.push('with prompt');
    if (inputCount > 0) values.push(`${inputCount} ${plural(inputCount, 'input')}`);
    if (environmentCount > 0) values.push(`${environmentCount} env`);
  } else {
    if (readString(args, 'expectedRunId')) values.push('generation checked');
    if (readString(args, 'reason')) values.push('with reason');
    if (readBoolean(args, 'dryRun')) values.push('dry run');
    if (readString(args, 'job')) values.push('job override');
    if (readString(args, 'runner')) values.push('runner override');
  }

  return values;
}

/** The header beside the tool name: action, target, and the call's flags. */
export function workflowCallSummary(toolName: WorkflowToolName, args: JsonRecord): WorkflowCallSummary {
  const target = toolTarget(toolName, args);
  return {
    action: toolAction(toolName, args),
    ...(target === undefined ? {} : { target }),
    metadata: callMetadata(toolName, args),
  };
}

function parseCatalog(payload: JsonRecord | undefined): WorkflowCatalog | undefined {
  if (!Array.isArray(payload?.workflows)) return undefined;

  const workflows = payload.workflows.flatMap((value) => {
    const record = asRecord(value);
    const path = readString(record, 'path');
    if (!record || !path) return [];
    return [
      {
        description: readString(record, 'description') ?? '',
        name: readString(record, 'name') ?? '',
        path,
        tags: readStringArray(record, 'tags'),
      },
    ];
  });
  const tags = Array.isArray(payload.tags)
    ? payload.tags.flatMap((value) => {
        const record = asRecord(value);
        const tag = readString(record, 'tag');
        const count = readNumber(record, 'count');
        return tag && count !== undefined ? [{ count, tag }] : [];
      })
    : [];

  const directory = readString(payload, 'directory');
  return {
    ...(directory === undefined ? {} : { directory }),
    page: readNumber(payload, 'page') ?? 1,
    pageSize: readNumber(payload, 'pageSize') ?? workflows.length,
    tags,
    total: readNumber(payload, 'total') ?? workflows.length,
    totalPages: readNumber(payload, 'totalPages') ?? (workflows.length > 0 ? 1 : 0),
    workflows,
  };
}

function catalogItemLines(item: WorkflowCatalogItem, expanded: boolean): ToolLine[] {
  const name = item.name || workflowNameFromPath(item.path);
  const lines = [line(`› ${name} · ${item.path}`, 'text')];
  if (!expanded) return lines;
  if (item.description) lines.push(line(item.description, 'muted', { indent: true }));
  if (item.tags.length > 0) lines.push(line(`tags ${item.tags.join(', ')}`, 'dim', { indent: true }));
  return lines;
}

function catalogLines(result: ToolResultView | null, options: WorkflowRenderOptions): ToolLine[] | undefined {
  const catalog = parseCatalog(firstPayload(result));
  if (!catalog) return undefined;

  const pageLabel = `page ${catalog.page}/${catalog.totalPages}`;
  const glyph = catalog.total > 0 ? '✓' : '○';
  const summary = line(`${glyph} ${catalog.total} ${plural(catalog.total, 'workflow')} · ${pageLabel}`, 'hi', {
    bold: true,
  });
  const shown = options.expanded ? catalog.workflows : catalog.workflows.slice(0, COLLAPSED_CATALOG_ROWS);
  const lines = [summary, ...shown.flatMap((item) => catalogItemLines(item, options.expanded))];
  const hidden = catalog.workflows.length - shown.length;
  if (hidden > 0) lines.push(hiddenLine(hidden));

  if (options.expanded) {
    if (catalog.tags.length > 0) {
      const tags = catalog.tags.map(({ count, tag }) => `${tag} (${count})`).join(', ');
      lines.push(labelValue('available tags', tags));
    }
    if (catalog.directory) lines.push(labelValue('directory', catalog.directory));
    lines.push(labelValue('page size', String(catalog.pageSize)));
  }
  return lines;
}

function readWorkflowState(record: JsonRecord): WorkflowState {
  const stage = readString(record, 'effectiveStage') ?? readString(record, 'stage') ?? 'unknown';
  const outcome = readString(record, 'effectiveOutcome') ?? readString(record, 'outcome');
  const executionState = readString(record, 'executionState');

  if (outcome === 'interrupted') return { tone: 'warning', glyph: '!', label: 'interrupted' };
  if (stage === 'error' || outcome === 'failed') return { tone: 'error', glyph: '✗', label: 'failed' };
  if (stage === 'completed' && outcome === 'skipped') return { tone: 'muted', glyph: '○', label: 'skipped' };
  if (stage === 'completed') return { tone: 'success', glyph: '✓', label: 'completed' };
  if (executionState === 'paused') return { tone: 'warning', glyph: 'Ⅱ', label: 'paused' };
  if (executionState === 'pause_requested') return { tone: 'warning', glyph: '◐', label: 'pause requested' };
  if (executionState === 'resume_requested') return { tone: 'warning', glyph: '◐', label: 'resume requested' };
  if (stage === 'running') return { tone: 'accent', glyph: '◐', label: 'running' };
  return { tone: 'muted', glyph: '○', label: stage };
}

function recordScope(record: JsonRecord): string {
  const runKey = readString(record, 'runKey') ?? 'unknown run';
  const workspace = readString(record, 'workspace');
  return workspace ? `${workspace}/${runKey}` : runKey;
}

function currentActivity(record: JsonRecord): ToolLine | undefined {
  const cursor = asRecord(record.executionCursor);
  const job = readString(cursor, 'job') ?? readString(record, 'job');
  const step = readString(cursor, 'stepName');
  const phase = readString(cursor, 'phase');
  if (!job && !step && !phase) return undefined;
  const context = job ?? phase ?? 'workflow';
  return line(`[${context}] ${step ?? phase ?? 'running'}`, 'text', { indent: true });
}

function launcherLabel(record: JsonRecord): string | undefined {
  const launcher = asRecord(record.launcher);
  const type = readString(launcher, 'type');
  if (!type) return undefined;
  const identity = readString(launcher, 'sessionName') ?? readString(launcher, 'workspaceId');
  return identity ? `${type} ${identity}` : type;
}

function workflowRecordLines(record: JsonRecord, expanded: boolean): ToolLine[] | undefined {
  const runKey = readString(record, 'runKey');
  const stage = readString(record, 'stage');
  if (!runKey || !stage) return undefined;

  const state = readWorkflowState(record);
  const displayName = readString(record, 'displayName') ?? runKey;
  const lines = [
    line(`${state.glyph} ${displayName} · ${recordScope(record)} · ${state.label}`, state.tone, { bold: true }),
  ];
  const activity = currentActivity(record);
  if (activity) lines.push(activity);

  const failure = readString(record, 'errorMessage') ?? readString(record, 'failureReason');
  if (failure) lines.push(line(`error ${failure}`, 'error'));
  const staleReason = readString(record, 'staleReason');
  if (staleReason) lines.push(line(`stale ${staleReason}`, 'warning'));

  const startedAt = readString(record, 'startedAt');
  const exitCode = readNumber(record, 'exitCode');
  const conciseMetadata = [
    readString(record, 'runner') ? `runner ${readString(record, 'runner')}` : undefined,
    readBoolean(record, 'dryRun') ? 'dry run' : undefined,
    exitCode !== undefined ? `exit ${exitCode}` : undefined,
    startedAt ? `started ${statusTimestamp(startedAt)}` : undefined,
  ].filter((value): value is string => !!value);
  if (conciseMetadata.length > 0) lines.push(line(conciseMetadata.join(' · '), 'dim'));

  if (!expanded) return lines;

  const finishedAt = readString(record, 'finishedAt');
  const repairId = readString(record, 'activeRepairId');
  const detailedValues: Array<[string, string | undefined]> = [
    ['workflow', readString(record, 'workflowPath')],
    ['workflow id', readString(record, 'workflowId')],
    ['run id', readString(record, 'runId')],
    ['launcher', launcherLabel(record)],
    ['job', readString(record, 'job')],
    ['outcome', readString(record, 'effectiveOutcome') ?? readString(record, 'outcome')],
    ['finished', finishedAt ? statusTimestamp(finishedAt) : undefined],
    ['pid', readNumber(record, 'pid')?.toString()],
    ['repair', repairId ? `#${repairId}` : undefined],
    ['worktree', readString(record, 'worktreeBranch') ?? readString(record, 'worktreePath')],
  ];
  for (const [label, value] of detailedValues) {
    if (value) lines.push(labelValue(label, value));
  }
  return lines;
}

function statusLines(result: ToolResultView | null, options: WorkflowRenderOptions): ToolLine[] | undefined {
  const payload = firstPayload(result);
  if (!payload) return undefined;
  return workflowRecordLines(payload, options.expanded);
}

function nestedRequestedAt(payload: JsonRecord | undefined): string | undefined {
  return readString(asRecord(payload?.request), 'requestedAt') ?? readString(payload, 'requestedAt');
}

function controlLines(
  action: string,
  args: JsonRecord,
  result: ToolResultView | null,
  options: WorkflowRenderOptions,
): ToolLine[] {
  const payload = firstPayload(result);
  const scope = targetScope(args) ?? readString(payload, 'runKey') ?? 'workflow';
  const payloadWorkspace = readString(payload, 'workspace');
  const resolvedScope = payloadWorkspace && !scope.includes('/') ? `${payloadWorkspace}/${scope}` : scope;
  const lines = [line(`◐ ${action} requested · ${resolvedScope}`, 'warning', { bold: true })];
  const requestedAt = nestedRequestedAt(payload);
  if (requestedAt) lines.push(labelValue('requested', statusTimestamp(requestedAt)));
  if (options.expanded) lines.push(line('verify the transition with workflow_run status', 'dim'));
  return lines;
}

function matchLine(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function launchSummary(text: string, args: JsonRecord): { name: string; scope: string; state: WorkflowState } {
  const startedName = matchLine(text, /^Started (.+) in workspace .+\.$/mu);
  const workspace = matchLine(text, /^Started .+ in workspace (.+)\.$/mu) ?? readString(args, 'workspace');
  const runKey = matchLine(text, /^Run key:\s*(.+)$/mu);
  const path = readString(args, 'workflowPath');
  const name = startedName ?? workflowNameFromPath(path);
  const scope = runKey ? (workspace ? `${workspace}/${runKey}` : runKey) : (workspace ?? path ?? 'workflow');

  if (/Workflow completed successfully/iu.test(text)) {
    return { name, scope, state: { tone: 'success', glyph: '✓', label: 'completed' } };
  }
  if (/Workflow skipped/iu.test(text)) {
    return { name, scope, state: { tone: 'muted', glyph: '○', label: 'skipped' } };
  }
  if (/no run was registered/iu.test(text)) {
    return { name, scope, state: { tone: 'warning', glyph: '◐', label: 'starting · run key pending' } };
  }
  return { name, scope, state: { tone: 'accent', glyph: '◐', label: runKey ? 'started' : 'launch accepted' } };
}

function launchLines(args: JsonRecord, result: ToolResultView | null, options: WorkflowRenderOptions): ToolLine[] {
  const text = textBlocks(result).join('\n');
  const summary = launchSummary(text, args);
  const lines = [
    line(`${summary.state.glyph} ${summary.name} · ${summary.scope} · ${summary.state.label}`, summary.state.tone, {
      bold: true,
    }),
  ];
  const metadata = [
    readString(args, 'job') ? `job ${readString(args, 'job')}` : undefined,
    readString(args, 'runner') ? `runner ${readString(args, 'runner')}` : undefined,
    readBoolean(args, 'dryRun') ? 'dry run' : undefined,
  ].filter((value): value is string => !!value);
  if (metadata.length > 0) lines.push(line(metadata.join(' · '), 'dim'));
  if (options.expanded) {
    const details = detailLines(result).filter((entry) => !entry.startsWith('Next steps for the agent:'));
    lines.push(...details.map((entry) => line(entry, 'text')));
  }
  return lines;
}

function splitEvidence(text: string): EvidenceSection[] {
  const sections: EvidenceSection[] = [];
  let current: EvidenceSection | undefined;
  for (const entry of text.split('\n')) {
    const match = entry.match(/^--- (.+) ---$/u);
    if (match?.[1]) {
      current = { body: [], name: match[1] };
      sections.push(current);
      continue;
    }
    current?.body.push(entry);
  }
  return sections;
}

function recoveryEvidenceLines(
  args: JsonRecord,
  result: ToolResultView | null,
  options: WorkflowRenderOptions,
): ToolLine[] {
  const sections = splitEvidence(textBlocks(result).join('\n'));
  const runSection = sections.find((section) => section.name === 'run.json');
  const record = parseJsonRecord(runSection?.body.join('\n'));
  const recordLines = record ? workflowRecordLines(record, options.expanded) : undefined;
  const evidenceSections = sections.filter((section) => section.name !== 'run.json');
  const scope = targetScope(args) ?? 'workflow';
  const lines = recordLines ?? [line(`✓ recovery evidence · ${scope}`, 'success', { bold: true })];
  const names = evidenceSections.map((section) => section.name);
  lines.push(
    names.length > 0 ? labelValue('evidence', names.join(', ')) : line('no durable evidence files recorded', 'muted'),
  );
  if (options.expanded) {
    for (const section of evidenceSections) {
      lines.push(line(section.name, 'hi', { bold: true }));
      lines.push(...section.body.filter((entry) => entry.length > 0).map((entry) => line(entry, 'text')));
    }
  }
  return lines;
}

function simpleActionLines(
  action: string,
  args: JsonRecord,
  result: ToolResultView | null,
  options: WorkflowRenderOptions,
): ToolLine[] {
  const scope = targetScope(args) ?? 'workflow';
  const actionLabel: Record<string, string> = {
    follow: 'following output',
    open: 'launcher opened',
    recover: readBoolean(args, 'dryRun') ? 'recovery dry run finished' : 'recovery accepted',
    tail: 'launcher output checked',
  };
  const state: WorkflowState =
    action === 'recover'
      ? { tone: 'accent', glyph: '◐', label: actionLabel[action] ?? action }
      : { tone: 'success', glyph: '✓', label: actionLabel[action] ?? action };
  const lines = [line(`${state.glyph} ${state.label} · ${scope}`, state.tone, { bold: true })];
  const details = detailLines(result);
  if (action === 'tail') {
    const workflowLine = details.find((entry) => entry.startsWith('Workflow:'));
    const stageLine = details.find((entry) => entry.startsWith('Stage:'));
    if (workflowLine) lines.push(line(workflowLine, 'text'));
    if (stageLine) lines.push(line(stageLine, 'text'));
  }
  if (options.expanded) lines.push(...details.map((entry) => line(entry, 'text')));
  return lines;
}

function failureLines(
  toolName: WorkflowToolName,
  args: JsonRecord,
  result: ToolResultView | null,
  options: WorkflowRenderOptions,
): ToolLine[] {
  const action = toolAction(toolName, args);
  const target = toolTarget(toolName, args);
  const details = detailLines(result);
  const shown = options.expanded ? details : details.slice(0, COLLAPSED_DETAIL_LINES);
  const lines = [
    line(`✗ ${action} failed${target ? ` · ${target}` : ''}`, 'error', { bold: true }),
    ...(shown.length > 0 ? shown.map((entry) => line(entry, 'text')) : [line('Unknown workflow error', 'error')]),
  ];
  const hidden = details.length - shown.length;
  if (hidden > 0) lines.push(hiddenLine(hidden));
  return lines;
}

function partialLines(toolName: WorkflowToolName, args: JsonRecord, result: ToolResultView | null): ToolLine[] {
  const details = detailLines(result);
  const shown = details.slice(-PARTIAL_DETAIL_LINES);
  const action = toolAction(toolName, args);
  const target = toolTarget(toolName, args);
  const hidden = details.length - shown.length;
  const lines = [line(`◐ ${action}${target ? ` · ${target}` : ''}`, 'accent', { bold: true })];
  if (hidden > 0) lines.push(line(`… ${hidden} earlier`, 'dim'));
  lines.push(...shown.map((entry) => line(entry, 'text')));
  return lines;
}

function fallbackLines(result: ToolResultView | null, options: WorkflowRenderOptions): ToolLine[] {
  const details = detailLines(result);
  if (details.length === 0) return [line('No workflow output.', 'muted')];
  const shown = options.expanded ? details : details.slice(0, COLLAPSED_DETAIL_LINES);
  const lines = shown.map((entry) => line(entry, 'text'));
  const hidden = details.length - shown.length;
  if (hidden > 0) lines.push(hiddenLine(hidden));
  return lines;
}

/** The body of a workflow tool card, chosen by tool, action, and result shape. */
export function workflowResultLines(
  toolName: WorkflowToolName,
  args: JsonRecord,
  result: ToolResultView | null,
  options: WorkflowRenderOptions,
): ToolLine[] {
  if (options.isPartial) return partialLines(toolName, args, result);
  if (options.isError) return failureLines(toolName, args, result, options);

  if (toolName === 'list_workflows') return catalogLines(result, options) ?? fallbackLines(result, options);
  if (toolName === 'launch_workflow') return launchLines(args, result, options);

  const action = readString(args, 'action');
  if (action === 'status') return statusLines(result, options) ?? fallbackLines(result, options);
  if (action === 'pause' || action === 'resume' || action === 'stop')
    return controlLines(action, args, result, options);
  if (action === 'recovery-evidence') return recoveryEvidenceLines(args, result, options);
  if (action === 'follow' || action === 'open' || action === 'recover' || action === 'tail') {
    return simpleActionLines(action, args, result, options);
  }
  return fallbackLines(result, options);
}
