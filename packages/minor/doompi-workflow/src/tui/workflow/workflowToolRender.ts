import { DoomToolCall, DoomToolResult, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

export type WorkflowToolName = 'launch_workflow' | 'list_workflows' | 'workflow_run';
export type WorkflowPiToolName = WorkflowToolName;

interface WorkflowToolResultLike {
  content?: unknown;
  isError?: boolean;
}

interface WorkflowToolRenderOptions {
  expanded: boolean;
  isError?: boolean;
  isPartial?: boolean;
}

type JsonRecord = Record<string, unknown>;

type WorkflowState = {
  color: ThemeColor;
  glyph: string;
  label: string;
};

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
    return undefined;
  }
}

function textBlocks(result: WorkflowToolResultLike): string[] {
  if (!Array.isArray(result.content)) return [];
  return result.content.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
}

function detailLines(result: WorkflowToolResultLike): string[] {
  return textBlocks(result)
    .flatMap((block) => block.split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function firstPayload(result: WorkflowToolResultLike): JsonRecord | undefined {
  return parseJsonRecord(textBlocks(result)[0]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function labelValue(label: string, value: string, theme: Theme): string {
  return `${theme.fg('dim', `${label} `)}${theme.fg('text', value)}`;
}

function targetScope(args: Record<string, unknown>): string | undefined {
  const runKey = readString(args, 'runKey');
  if (!runKey) return undefined;
  const workspace = readString(args, 'workspace');
  return workspace ? `${workspace}/${runKey}` : runKey;
}

function toolAction(toolName: WorkflowPiToolName, args: Record<string, unknown>): string {
  if (toolName === 'list_workflows') return 'list';
  if (toolName === 'launch_workflow') return 'launch';
  return readString(args, 'action') ?? 'run';
}

function toolTarget(toolName: WorkflowPiToolName, args: Record<string, unknown>): string | undefined {
  if (toolName === 'list_workflows') return readString(args, 'directory');
  if (toolName === 'launch_workflow') return readString(args, 'workflowPath');
  return targetScope(args);
}

function renderResult(lines: readonly string[], theme: Theme, expanded: boolean): Component {
  return new DoomToolResult(lines, theme, { wrap: expanded });
}

function hiddenDetailLine(hidden: number, theme: Theme): string {
  return theme.fg('dim', `… ${hidden} more · ctrl+o`);
}

function statusTimestamp(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function workflowNameFromPath(path: string | undefined): string {
  if (!path) return 'workflow';
  const filename = path.split('/').at(-1) ?? path;
  return filename.replace(/\.workflow\.ya?ml$/u, '') || filename;
}

function callMetadata(toolName: WorkflowPiToolName, args: Record<string, unknown>, theme: Theme): string[] {
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
    const expectedRunId = readString(args, 'expectedRunId');
    if (expectedRunId) values.push('generation checked');
    if (readString(args, 'reason')) values.push('with reason');
    if (readBoolean(args, 'dryRun')) values.push('dry run');
    if (readString(args, 'job')) values.push('job override');
    if (readString(args, 'runner')) values.push('runner override');
  }

  return values.map((value) => theme.fg('dim', value));
}

export function renderWorkflowToolCall(
  toolName: WorkflowPiToolName,
  args: Record<string, unknown>,
  theme: Theme,
): Component {
  const action = toolAction(toolName, args);
  const target = toolTarget(toolName, args);
  const metadata = callMetadata(toolName, args, theme);
  const purpose = [theme.bold(action), target ? theme.fg('muted', target) : undefined, ...metadata]
    .filter((part): part is string => !!part)
    .join(theme.fg('dim', ' · '));
  return new DoomToolCall(renderToolHeading('workflow', purpose, theme));
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

  return {
    directory: readString(payload, 'directory'),
    page: readNumber(payload, 'page') ?? 1,
    pageSize: readNumber(payload, 'pageSize') ?? workflows.length,
    tags,
    total: readNumber(payload, 'total') ?? workflows.length,
    totalPages: readNumber(payload, 'totalPages') ?? (workflows.length > 0 ? 1 : 0),
    workflows,
  };
}

function catalogItemLines(item: WorkflowCatalogItem, expanded: boolean, theme: Theme): string[] {
  const name = item.name || workflowNameFromPath(item.path);
  const lines = [`${theme.fg('accent', '›')} ${theme.bold(name)} ${theme.fg('muted', `· ${item.path}`)}`];
  if (!expanded) return lines;
  if (item.description) lines.push(`  ${theme.fg('text', item.description)}`);
  if (item.tags.length > 0) lines.push(`  ${labelValue('tags', item.tags.join(', '), theme)}`);
  return lines;
}

function renderCatalogResult(
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component | undefined {
  const catalog = parseCatalog(firstPayload(result));
  if (!catalog) return undefined;

  const pageLabel = `page ${catalog.page}/${catalog.totalPages}`;
  const summary = `${theme.fg(catalog.total > 0 ? 'success' : 'muted', catalog.total > 0 ? '✓' : '○')} ${theme.bold(
    `${catalog.total} ${plural(catalog.total, 'workflow')}`,
  )} ${theme.fg('dim', `· ${pageLabel}`)}`;
  const shown = options.expanded ? catalog.workflows : catalog.workflows.slice(0, COLLAPSED_CATALOG_ROWS);
  const lines = [summary, ...shown.flatMap((item) => catalogItemLines(item, options.expanded, theme))];
  const hidden = catalog.workflows.length - shown.length;
  if (hidden > 0) lines.push(hiddenDetailLine(hidden, theme));

  if (options.expanded) {
    if (catalog.tags.length > 0) {
      const tags = catalog.tags.map(({ count, tag }) => `${tag} (${count})`).join(', ');
      lines.push(labelValue('available tags', tags, theme));
    }
    if (catalog.directory) lines.push(labelValue('directory', catalog.directory, theme));
    lines.push(labelValue('page size', String(catalog.pageSize), theme));
  }

  return renderResult(lines, theme, options.expanded);
}

function readWorkflowState(record: JsonRecord): WorkflowState {
  const stage = readString(record, 'effectiveStage') ?? readString(record, 'stage') ?? 'unknown';
  const outcome = readString(record, 'effectiveOutcome') ?? readString(record, 'outcome');
  const executionState = readString(record, 'executionState');

  if (outcome === 'interrupted') return { color: 'warning', glyph: '!', label: 'interrupted' };
  if (stage === 'error' || outcome === 'failed') return { color: 'error', glyph: '✗', label: 'failed' };
  if (stage === 'completed' && outcome === 'skipped') return { color: 'muted', glyph: '○', label: 'skipped' };
  if (stage === 'completed') return { color: 'success', glyph: '✓', label: 'completed' };
  if (executionState === 'paused') return { color: 'warning', glyph: 'Ⅱ', label: 'paused' };
  if (executionState === 'pause_requested') return { color: 'warning', glyph: '◐', label: 'pause requested' };
  if (executionState === 'resume_requested') return { color: 'warning', glyph: '◐', label: 'resume requested' };
  if (stage === 'running') return { color: 'accent', glyph: '◐', label: 'running' };
  return { color: 'muted', glyph: '○', label: stage };
}

function recordScope(record: JsonRecord): string {
  const runKey = readString(record, 'runKey') ?? 'unknown run';
  const workspace = readString(record, 'workspace');
  return workspace ? `${workspace}/${runKey}` : runKey;
}

function currentActivity(record: JsonRecord, theme: Theme): string | undefined {
  const cursor = asRecord(record.executionCursor);
  const job = readString(cursor, 'job') ?? readString(record, 'job');
  const step = readString(cursor, 'stepName');
  const phase = readString(cursor, 'phase');
  if (!job && !step && !phase) return undefined;
  const context = job ?? phase ?? 'workflow';
  return `  ${theme.fg('muted', `[${context}]`)} ${theme.fg('text', step ?? phase ?? 'running')}`;
}

function launcherLabel(record: JsonRecord): string | undefined {
  const launcher = asRecord(record.launcher);
  const type = readString(launcher, 'type');
  if (!type) return undefined;
  const identity = readString(launcher, 'sessionName') ?? readString(launcher, 'workspaceId');
  return identity ? `${type} ${identity}` : type;
}

function workflowRecordLines(record: JsonRecord, expanded: boolean, theme: Theme): string[] | undefined {
  const runKey = readString(record, 'runKey');
  const stage = readString(record, 'stage');
  if (!runKey || !stage) return undefined;

  const state = readWorkflowState(record);
  const displayName = readString(record, 'displayName') ?? runKey;
  const heading = `${theme.fg(state.color, state.glyph)} ${theme.bold(displayName)} ${theme.fg(
    'dim',
    `· ${recordScope(record)} ·`,
  )} ${theme.fg(state.color, state.label)}`;
  const lines = [heading];
  const activity = currentActivity(record, theme);
  if (activity) lines.push(activity);

  const failure = readString(record, 'errorMessage') ?? readString(record, 'failureReason');
  if (failure) lines.push(`${theme.fg('error', 'error')} ${theme.fg('text', failure)}`);
  const staleReason = readString(record, 'staleReason');
  if (staleReason) lines.push(`${theme.fg('warning', 'stale')} ${theme.fg('text', staleReason)}`);

  const conciseMetadata = [
    readString(record, 'runner') ? `runner ${readString(record, 'runner')}` : undefined,
    readBoolean(record, 'dryRun') ? 'dry run' : undefined,
    readNumber(record, 'exitCode') !== undefined ? `exit ${readNumber(record, 'exitCode')}` : undefined,
    readString(record, 'startedAt') ? `started ${statusTimestamp(readString(record, 'startedAt') ?? '')}` : undefined,
  ].filter((value): value is string => !!value);
  if (conciseMetadata.length > 0) lines.push(theme.fg('dim', conciseMetadata.join(' · ')));

  if (!expanded) return lines;

  const detailedValues: Array<[string, string | undefined]> = [
    ['workflow', readString(record, 'workflowPath')],
    ['workflow id', readString(record, 'workflowId')],
    ['run id', readString(record, 'runId')],
    ['launcher', launcherLabel(record)],
    ['job', readString(record, 'job')],
    ['outcome', readString(record, 'effectiveOutcome') ?? readString(record, 'outcome')],
    [
      'finished',
      readString(record, 'finishedAt') ? statusTimestamp(readString(record, 'finishedAt') ?? '') : undefined,
    ],
    ['pid', readNumber(record, 'pid')?.toString()],
    ['repair', readString(record, 'activeRepairId') ? `#${readString(record, 'activeRepairId')}` : undefined],
    ['worktree', readString(record, 'worktreeBranch') ?? readString(record, 'worktreePath')],
  ];
  for (const [label, value] of detailedValues) {
    if (value) lines.push(labelValue(label, value, theme));
  }
  return lines;
}

function renderStatusResult(
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component | undefined {
  const payload = firstPayload(result);
  if (!payload) return undefined;
  const lines = workflowRecordLines(payload, options.expanded, theme);
  return lines ? renderResult(lines, theme, options.expanded) : undefined;
}

function nestedRequestedAt(payload: JsonRecord | undefined): string | undefined {
  return readString(asRecord(payload?.request), 'requestedAt') ?? readString(payload, 'requestedAt');
}

function renderControlResult(
  action: string,
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const payload = firstPayload(result);
  const scope = targetScope(args) ?? readString(payload, 'runKey') ?? 'workflow';
  const payloadWorkspace = readString(payload, 'workspace');
  const resolvedScope = payloadWorkspace && !scope.includes('/') ? `${payloadWorkspace}/${scope}` : scope;
  const lines = [
    `${theme.fg('warning', '◐')} ${theme.bold(`${action} requested`)} ${theme.fg('dim', `· ${resolvedScope}`)}`,
  ];
  const requestedAt = nestedRequestedAt(payload);
  if (requestedAt) lines.push(labelValue('requested', statusTimestamp(requestedAt), theme));
  if (options.expanded) lines.push(theme.fg('dim', 'verify the transition with workflow_run status'));
  return renderResult(lines, theme, options.expanded);
}

function matchLine(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function launchSummary(
  text: string,
  args: Record<string, unknown>,
): { name: string; scope: string; state: WorkflowState } {
  const startedName = matchLine(text, /^Started (.+) in workspace .+\.$/mu);
  const workspace = matchLine(text, /^Started .+ in workspace (.+)\.$/mu) ?? readString(args, 'workspace');
  const runKey = matchLine(text, /^Run key:\s*(.+)$/mu);
  const path = readString(args, 'workflowPath');
  const name = startedName ?? workflowNameFromPath(path);
  const scope = runKey ? (workspace ? `${workspace}/${runKey}` : runKey) : (workspace ?? path ?? 'workflow');

  if (/Workflow completed successfully/iu.test(text)) {
    return { name, scope, state: { color: 'success', glyph: '✓', label: 'completed' } };
  }
  if (/Workflow skipped/iu.test(text)) {
    return { name, scope, state: { color: 'muted', glyph: '○', label: 'skipped' } };
  }
  if (/no run was registered/iu.test(text)) {
    return { name, scope, state: { color: 'warning', glyph: '◐', label: 'starting · run key pending' } };
  }
  return { name, scope, state: { color: 'accent', glyph: '◐', label: runKey ? 'started' : 'launch accepted' } };
}

function renderLaunchResult(
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const blocks = textBlocks(result);
  const text = blocks.join('\n');
  const summary = launchSummary(text, args);
  const lines = [
    `${theme.fg(summary.state.color, summary.state.glyph)} ${theme.bold(summary.name)} ${theme.fg(
      'dim',
      `· ${summary.scope} ·`,
    )} ${theme.fg(summary.state.color, summary.state.label)}`,
  ];
  const metadata = [
    readString(args, 'job') ? `job ${readString(args, 'job')}` : undefined,
    readString(args, 'runner') ? `runner ${readString(args, 'runner')}` : undefined,
    readBoolean(args, 'dryRun') ? 'dry run' : undefined,
  ].filter((value): value is string => !!value);
  if (metadata.length > 0) lines.push(theme.fg('dim', metadata.join(' · ')));
  if (options.expanded) {
    const details = detailLines(result).filter((line) => !line.startsWith('Next steps for the agent:'));
    if (details.length > 0) lines.push(...details);
  }
  return renderResult(lines, theme, options.expanded);
}

function splitEvidence(text: string): EvidenceSection[] {
  const sections: EvidenceSection[] = [];
  let current: EvidenceSection | undefined;
  for (const line of text.split('\n')) {
    const match = line.match(/^--- (.+) ---$/u);
    if (match?.[1]) {
      current = { body: [], name: match[1] };
      sections.push(current);
      continue;
    }
    current?.body.push(line);
  }
  return sections;
}

function recoveryRecord(sections: EvidenceSection[]): JsonRecord | undefined {
  const runSection = sections.find((section) => section.name === 'run.json');
  return parseJsonRecord(runSection?.body.join('\n'));
}

function renderRecoveryEvidenceResult(
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const text = textBlocks(result).join('\n');
  const sections = splitEvidence(text);
  const record = recoveryRecord(sections);
  const recordLines = record ? workflowRecordLines(record, options.expanded, theme) : undefined;
  const evidenceSections = sections.filter((section) => section.name !== 'run.json');
  const scope = targetScope(args) ?? 'workflow';
  const lines = recordLines ?? [
    `${theme.fg('success', '✓')} ${theme.bold('recovery evidence')} ${theme.fg('dim', `· ${scope}`)}`,
  ];
  const names = evidenceSections.map((section) => section.name);
  lines.push(
    names.length > 0
      ? labelValue('evidence', names.join(', '), theme)
      : theme.fg('muted', 'no durable evidence files recorded'),
  );

  if (options.expanded) {
    for (const section of evidenceSections) {
      lines.push(theme.bold(section.name), ...section.body.filter((line) => line.length > 0));
    }
  }
  return renderResult(lines, theme, options.expanded);
}

function renderSimpleActionResult(
  action: string,
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const scope = targetScope(args) ?? 'workflow';
  const actionLabel: Record<string, string> = {
    follow: 'following output',
    open: 'launcher opened',
    recover: readBoolean(args, 'dryRun') ? 'recovery dry run finished' : 'recovery accepted',
    tail: 'launcher output checked',
  };
  const state: WorkflowState =
    action === 'recover'
      ? { color: 'accent', glyph: '◐', label: actionLabel[action] ?? action }
      : { color: 'success', glyph: '✓', label: actionLabel[action] ?? action };
  const lines = [`${theme.fg(state.color, state.glyph)} ${theme.bold(state.label)} ${theme.fg('dim', `· ${scope}`)}`];
  const details = detailLines(result);
  if (action === 'tail') {
    const stageLine = details.find((line) => line.startsWith('Stage:'));
    const workflowLine = details.find((line) => line.startsWith('Workflow:'));
    if (workflowLine) lines.push(workflowLine);
    if (stageLine) lines.push(stageLine);
  }
  if (options.expanded && details.length > 0) lines.push(...details);
  return renderResult(lines, theme, options.expanded);
}

function renderFailure(
  toolName: WorkflowPiToolName,
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const action = toolAction(toolName, args);
  const target = toolTarget(toolName, args);
  const summary = `${theme.fg('error', '✗')} ${theme.bold(`${action} failed`)}${
    target ? theme.fg('dim', ` · ${target}`) : ''
  }`;
  const details = detailLines(result);
  const shown = options.expanded ? details : details.slice(0, COLLAPSED_DETAIL_LINES);
  const lines = [summary, ...(shown.length > 0 ? shown : [theme.fg('error', 'Unknown workflow error')])];
  const hidden = details.length - shown.length;
  if (hidden > 0) lines.push(hiddenDetailLine(hidden, theme));
  return renderResult(lines, theme, options.expanded);
}

function renderPartial(
  toolName: WorkflowPiToolName,
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  const details = detailLines(result);
  const shown = details.slice(-PARTIAL_DETAIL_LINES);
  const action = toolAction(toolName, args);
  const target = toolTarget(toolName, args);
  const summary = `${theme.fg('accent', '◐')} ${theme.bold(action)}${target ? theme.fg('dim', ` · ${target}`) : ''}`;
  const hidden = details.length - shown.length;
  const lines = [summary];
  if (hidden > 0) lines.push(theme.fg('dim', `… ${hidden} earlier`));
  lines.push(...shown);
  return renderResult(lines, theme, options.expanded);
}

function renderFallback(result: WorkflowToolResultLike, options: WorkflowToolRenderOptions, theme: Theme): Component {
  const details = detailLines(result);
  if (details.length === 0) return renderResult([theme.fg('muted', 'No workflow output.')], theme, options.expanded);
  const shown = options.expanded ? details : details.slice(0, COLLAPSED_DETAIL_LINES);
  const lines = [...shown];
  const hidden = details.length - shown.length;
  if (hidden > 0) lines.push(hiddenDetailLine(hidden, theme));
  return renderResult(lines, theme, options.expanded);
}

export function renderWorkflowToolResult(
  toolName: WorkflowPiToolName,
  args: Record<string, unknown>,
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderOptions,
  theme: Theme,
): Component {
  if (options.isPartial) return renderPartial(toolName, args, result, options, theme);
  if (options.isError === true || result.isError === true) {
    return renderFailure(toolName, args, result, options, theme);
  }

  if (toolName === 'list_workflows') {
    return renderCatalogResult(result, options, theme) ?? renderFallback(result, options, theme);
  }
  if (toolName === 'launch_workflow') return renderLaunchResult(args, result, options, theme);

  const action = readString(args, 'action');
  if (action === 'status') {
    return renderStatusResult(result, options, theme) ?? renderFallback(result, options, theme);
  }
  if (action === 'pause' || action === 'resume' || action === 'stop') {
    return renderControlResult(action, args, result, options, theme);
  }
  if (action === 'recovery-evidence') {
    return renderRecoveryEvidenceResult(args, result, options, theme);
  }
  if (action === 'follow' || action === 'open' || action === 'recover' || action === 'tail') {
    return renderSimpleActionResult(action, args, result, options, theme);
  }
  return renderFallback(result, options, theme);
}
