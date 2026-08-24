import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/**
 * Purpose-first summaries for the goal tools. The TUI leaves these on Pi's
 * default shell; the shapes come from src/services/tools.ts (the inputs) and
 * the goal manager's messageResult, which reports a one-line outcome with
 * `details.error` marking a refusal.
 */

export const GOAL_TOOL_NAMES = ['goal_complete', 'goal_blocked'] as const;

export type LineTone = 'hi' | 'text' | 'dim' | 'muted' | 'success' | 'error' | 'warning' | 'accent';

export interface ToolLine {
  text: string;
  tone: LineTone;
  bold?: boolean;
  indent?: boolean;
}

export interface GoalCallSummary {
  action: string;
  detail?: string;
  metadata: string[];
}

export interface GoalRenderOptions {
  expanded: boolean;
  isError: boolean;
  isPartial: boolean;
}

type JsonRecord = Record<string, unknown>;

const PREVIEW_LENGTH = 72;

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

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? inlineText(value) || undefined : undefined;
}

function preview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH - 3)}…` : value;
}

function line(text: string, tone: LineTone, extra: Omit<ToolLine, 'text' | 'tone'> = {}): ToolLine {
  return { text, tone, ...extra };
}

function outputText(result: ToolResultView | null): string {
  if (!result) return '';
  return inlineText(
    result.content
      .flatMap((item) => {
        const record = asRecord(item);
        return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
      })
      .join(' '),
  );
}

/** The header beside the tool name: complete with its summary, or blocked with its reason and recurrence. */
export function goalCallSummary(toolName: string, args: JsonRecord): GoalCallSummary {
  if (toolName === 'goal_complete') {
    const summary = preview(readString(args, 'summary'));
    return { action: 'complete', ...(summary ? { detail: summary } : {}), metadata: [] };
  }
  const reason = preview(readString(args, 'reason'));
  const turns = args.repeated_turns;
  const metadata =
    typeof turns === 'number' && Number.isFinite(turns) ? [`${turns} ${turns === 1 ? 'turn' : 'turns'}`] : [];
  return { action: 'blocked', ...(reason ? { detail: reason } : {}), metadata };
}

/** The body: the manager's one-line outcome, with the full summary or evidence once expanded. */
export function goalResultLines(
  toolName: string,
  args: JsonRecord,
  result: ToolResultView | null,
  options: GoalRenderOptions,
): ToolLine[] {
  if (options.isPartial) return [line('◐ recording the goal outcome', 'warning')];
  const text = outputText(result);
  const refused = options.isError || asRecord(result?.details)?.error === true;
  const lines = refused
    ? [line(`✗ ${text || `${toolName} refused`}`, 'error')]
    : [line(`✓ ${text || (toolName === 'goal_complete' ? 'goal complete' : 'goal blocked')}`, 'success')];
  if (!options.expanded) return lines;
  const fields: ReadonlyArray<[string, string]> =
    toolName === 'goal_complete'
      ? [
          ['goal_id', 'goal'],
          ['summary', 'summary'],
        ]
      : [
          ['goal_id', 'goal'],
          ['reason', 'reason'],
          ['evidence', 'evidence'],
        ];
  for (const [key, label] of fields) {
    const value = readString(args, key);
    if (value) lines.push(line(`${label} ${value}`, 'text'));
  }
  return lines;
}
