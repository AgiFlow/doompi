import type { MessageLine, MessageLineTone } from '@agimon-ai/doompi-web-components';
import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/**
 * Purpose-first summaries for the plan-mode tools. The TUI leaves these on
 * Pi's default shell, so the shapes here come straight from the tool
 * definitions in src/services/planMode.ts: write_plan and complete_plan
 * report through `details` (written, path, phase, exited), run_fable_plan
 * carries the broker result, and record_debug_evidence only confirms.
 */

export const PLAN_TOOL_NAMES = ['record_debug_evidence', 'run_fable_plan', 'write_plan', 'complete_plan'] as const;

/** The toned lines the shared MessageLines draws; the vocabulary is the components package's. */
export type LineTone = MessageLineTone;
export type ToolLine = MessageLine;

export interface PlanCallSummary {
  action: string;
  detail?: string;
  metadata: string[];
}

export interface PlanRenderOptions {
  expanded: boolean;
  isError: boolean;
  isPartial: boolean;
}

type JsonRecord = Record<string, unknown>;

const COLLAPSED_BODY_LINES = 12;
const PREVIEW_LENGTH = 72;

const EVIDENCE_LISTS: ReadonlyArray<[key: string, label: string]> = [
  ['logs', 'log'],
  ['correlatedTraceEvidence', 'trace'],
  ['processOutput', 'process output'],
  ['browserConsoleEvidence', 'console entry'],
  ['correlationIds', 'correlation id'],
  ['timestamps', 'timestamp'],
  ['verifiedFacts', 'verified fact'],
  ['hypotheses', 'hypothesis'],
  ['unavailableEvidence', 'unavailable item'],
];

const PACKET_LISTS: ReadonlyArray<[key: string, label: string]> = [
  ['goal', 'goal'],
  ['constraints', 'constraint'],
  ['decisions', 'decision'],
  ['verifiedFindings', 'verified finding'],
  ['inferredFindings', 'inferred finding'],
  ['unresolvedQuestions', 'open question'],
];

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
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
  return typeof value === 'string' ? inlineText(value) || undefined : undefined;
}

function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function listLength(record: JsonRecord, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

function plural(count: number, singular: string): string {
  if (count === 1) return singular;
  if (singular.endsWith('y')) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}

function preview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH - 3)}…` : value;
}

function countMetadata(args: JsonRecord, lists: ReadonlyArray<[string, string]>): string[] {
  return lists.flatMap(([key, label]) => {
    const count = listLength(args, key);
    return count > 0 ? [`${count} ${plural(count, label)}`] : [];
  });
}

function line(text: string, tone: LineTone, extra: Omit<ToolLine, 'text' | 'tone'> = {}): ToolLine {
  return { text, tone, ...extra };
}

function outputText(result: ToolResultView | null): string {
  if (!result) return '';
  return result.content
    .flatMap((item) => {
      const record = asRecord(item);
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

function bodyLines(text: string, expanded: boolean): ToolLine[] {
  const all = text
    .split('\n')
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0);
  const shown = expanded ? all : all.slice(0, COLLAPSED_BODY_LINES);
  const lines = shown.map((entry) => line(entry, 'text'));
  if (all.length > shown.length) lines.push(line(`… ${all.length - shown.length} more lines`, 'dim'));
  return lines;
}

/** The header beside the tool name: what the call is for and how much it carries. */
export function planCallSummary(toolName: string, args: JsonRecord): PlanCallSummary {
  if (toolName === 'record_debug_evidence') {
    const issue = preview(readString(args, 'issue'));
    return {
      action: 'record evidence',
      ...(issue ? { detail: issue } : {}),
      metadata: countMetadata(args, EVIDENCE_LISTS),
    };
  }
  if (toolName === 'run_fable_plan') {
    const metadata = countMetadata(args, PACKET_LISTS);
    if (readString(args, 'currentPlan')) metadata.push('with current plan');
    return { action: 'fable draft', metadata };
  }
  if (toolName === 'write_plan') return { action: 'save plan', metadata: [] };
  const decision = readString(args, 'decision');
  return { action: decision ? `decide ${decision}` : 'request approval', metadata: [] };
}

function evidenceLines(args: JsonRecord, result: ToolResultView | null, options: PlanRenderOptions): ToolLine[] {
  const recorded = asRecord(result?.details)?.recorded === true;
  const lines = [
    recorded
      ? line('✓ evidence recorded as planning context', 'success')
      : line(`○ ${inlineText(outputText(result)) || 'not recorded'}`, 'muted'),
  ];
  if (!options.expanded) return lines;
  const fields: ReadonlyArray<[string, string]> = [
    ['issue', 'issue'],
    ['expectedBehavior', 'expected'],
    ['reproductionAttempt', 'reproduction'],
    ['actualBehavior', 'actual'],
  ];
  for (const [key, label] of fields) {
    const value = readString(args, key);
    if (value) lines.push(line(`${label} ${value}`, 'text'));
  }
  for (const [key, label] of EVIDENCE_LISTS) {
    const raw = args[key];
    const items = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
    if (items.length === 0) continue;
    lines.push(line(plural(items.length, label), 'hi', { bold: true }));
    lines.push(...items.map((item) => line(inlineText(item), 'text', { indent: true })));
  }
  return lines;
}

function fableLines(result: ToolResultView | null, options: PlanRenderOptions): ToolLine[] {
  const details = asRecord(result?.details);
  const text = outputText(result);
  if (details?.started !== true) {
    const code = readString(details, 'errorCode');
    return [line(`○ ${inlineText(text) || 'fable planning did not start'}${code ? ` · ${code}` : ''}`, 'muted')];
  }
  const status = readString(details, 'status') ?? 'unknown';
  const draft = typeof details?.draft === 'string' ? details.draft : undefined;
  const code = readString(details, 'errorCode');
  if (!draft) return [line(`✗ fable planning ${status}${code ? ` · ${code}` : ''}`, 'error')];
  const finished = status === 'completed';
  return [
    line(
      `${finished ? '✓' : '!'} fable draft · ${status}${code ? ` · ${code}` : ''}`,
      finished ? 'success' : 'warning',
      {
        bold: true,
      },
    ),
    ...bodyLines(draft, options.expanded),
  ];
}

function writeLines(result: ToolResultView | null, options: PlanRenderOptions): ToolLine[] {
  const details = asRecord(result?.details);
  const path = readString(details, 'path');
  if (options.isPartial) {
    const phase = readString(details, 'phase') ?? 'checking';
    return [line(`◐ ${phase}${path ? ` ${path}` : ''}`, 'warning')];
  }
  const duration = readNumber(details, 'durationMs');
  if (details?.written === true) {
    return [line(`✓ wrote ${path ?? 'the plan'}${duration === undefined ? '' : ` · ${duration}ms`}`, 'success')];
  }
  const lines = [line(`○ ${inlineText(outputText(result)) || 'plan not written'}`, 'muted')];
  if (path) lines.push(line(`path ${path}`, 'dim'));
  return lines;
}

function completeLines(result: ToolResultView | null): ToolLine[] {
  const text = inlineText(outputText(result));
  if (asRecord(result?.details)?.exited === true) {
    return [line(`✓ plan mode exited${text ? ` · ${text}` : ''}`, 'success')];
  }
  return [line(`○ staying in plan mode${text ? ` · ${text}` : ''}`, 'muted')];
}

/** The body of a plan tool card: the outcome line, plus the carried detail once expanded. */
export function planResultLines(
  toolName: string,
  args: JsonRecord,
  result: ToolResultView | null,
  options: PlanRenderOptions,
): ToolLine[] {
  if (options.isError) {
    const text = inlineText(outputText(result));
    return [line(`✗ ${text || `${toolName} failed`}`, 'error')];
  }
  if (toolName === 'record_debug_evidence') return evidenceLines(args, result, options);
  if (toolName === 'run_fable_plan') {
    if (options.isPartial) return [line('◐ drafting with the local Fable broker', 'warning')];
    return fableLines(result, options);
  }
  if (toolName === 'write_plan') return writeLines(result, options);
  if (options.isPartial) return [line('◐ waiting for the review decision', 'warning')];
  return completeLines(result);
}
