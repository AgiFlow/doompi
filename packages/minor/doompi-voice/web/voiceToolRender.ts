import type { MessageLine, MessageLineTone } from '@agimon-ai/doompi-web-components';
import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/**
 * The cockpit half of src/adapters/pi/voiceToolRender.ts: the catalog,
 * batch, and narration shapes reduced to toned lines so the cards stay a
 * thin mapping and the parsing is testable without a DOM. The tool names and
 * shape guards are duplicated from doompi-extension-contracts because web/
 * may import only this package's own pure modules.
 */

export const VOICE_DESCRIBE_TOOL = 'describe_voice_tools';
export const VOICE_USE_TOOL = 'use_voice_tools';
export const VOICE_NARRATE_TOOL = 'narrate';
export const VOICE_TOOL_NAMES = [VOICE_DESCRIBE_TOOL, VOICE_USE_TOOL, VOICE_NARRATE_TOOL] as const;

/** The toned lines the shared MessageLines draws; the vocabulary is the components package's. */
export type LineTone = MessageLineTone;
export type ToolLine = MessageLine;

export interface VoiceCallSummary {
  glyph?: string;
  action: string;
  /** A capability name or a narration preview; accented when it is a name. */
  detail?: string;
  detailIsName: boolean;
}

export interface VoiceRenderOptions {
  expanded: boolean;
  isError: boolean;
  isPartial: boolean;
}

type JsonRecord = Record<string, unknown>;

interface StatusStyle {
  tone: LineTone;
  glyph: string;
  label: string;
}

const COLLAPSED_CATALOG_ROWS = 6;
const COLLAPSED_RESULT_ROWS = 8;
const PREVIEW_LENGTH = 72;
const FAILED: StatusStyle = { tone: 'error', glyph: '✗', label: 'failed' };
const STATUS: Record<string, StatusStyle> = {
  playing: { tone: 'warning', glyph: '◐', label: 'playing' },
  completed: { tone: 'success', glyph: '✓', label: 'completed' },
  interrupted: { tone: 'warning', glyph: '⊘', label: 'interrupted' },
  superseded: { tone: 'dim', glyph: '○', label: 'superseded' },
  failed: FAILED,
  rejected: { tone: 'error', glyph: '✗', label: 'rejected' },
  cancelled: { tone: 'warning', glyph: '⊘', label: 'cancelled' },
  stopped: { tone: 'warning', glyph: '■', label: 'stopped' },
  not_executed: { tone: 'dim', glyph: '○', label: 'not executed' },
  preflight_failed: { tone: 'error', glyph: '✗', label: 'preflight failed' },
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function definedRecord(value: JsonRecord | undefined): value is JsonRecord {
  return value !== undefined;
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

function textBlocks(result: ToolResultView | null): string[] {
  if (!result) return [];
  return result.content.flatMap((item) => {
    const record = asRecord(item);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
}

function parseRecord(text: string | undefined): JsonRecord | undefined {
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    // Plain-text results are the fallback shape, not a failure.
    return undefined;
  }
}

function payload(result: ToolResultView | null): JsonRecord | undefined {
  return asRecord(result?.details) ?? parseRecord(textBlocks(result)[0]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function line(text: string, tone: LineTone, extra: Omit<ToolLine, 'text' | 'tone'> = {}): ToolLine {
  return { text, tone, ...extra };
}

function requestedNames(args: JsonRecord): string[] {
  const names = args.names;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
}

function requestedCalls(args: JsonRecord): JsonRecord[] {
  const calls = args.calls;
  return Array.isArray(calls) ? calls.map(asRecord).filter(definedRecord) : [];
}

/** The header beside the tool name, per tool: discover, run, or narrate. */
export function voiceCallSummary(toolName: string, args: JsonRecord): VoiceCallSummary {
  if (toolName === VOICE_NARRATE_TOOL) {
    const speech = typeof args.text === 'string' ? inlineText(args.text) : '';
    const preview = speech.length > PREVIEW_LENGTH ? `${speech.slice(0, PREVIEW_LENGTH - 3)}…` : speech;
    return { action: 'narrate', ...(preview ? { detail: preview } : {}), detailIsName: false };
  }
  if (toolName === VOICE_DESCRIBE_TOOL) {
    const names = requestedNames(args);
    if (names.length === 1) return { glyph: '☰', action: 'discover', detail: names[0], detailIsName: true };
    if (names.length > 1) {
      return { glyph: '☰', action: 'discover', detail: `· ${names.length} capabilities`, detailIsName: false };
    }
    return { glyph: '☰', action: 'discover', detailIsName: false };
  }
  const calls = requestedCalls(args);
  if (calls.length === 1) {
    const name = readString(calls[0], 'name');
    return { glyph: '▶', action: 'run', ...(name ? { detail: name } : {}), detailIsName: name !== undefined };
  }
  if (calls.length > 1)
    return { glyph: '▶', action: 'run', detail: `· ${calls.length} capabilities`, detailIsName: false };
  return { glyph: '▶', action: 'run', detailIsName: false };
}

function schemaType(schema: JsonRecord): string {
  const values = schema.enum;
  if (Array.isArray(values)) {
    const labels = values.filter((value): value is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof value),
    );
    if (labels.length > 0) return labels.join(' | ');
  }
  const literal = schema.const;
  if (['string', 'number', 'boolean'].includes(typeof literal)) return String(literal);
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === 'string').join(' | ');
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.map(asRecord).filter(definedRecord).map(schemaType).filter(Boolean);
    if (variants.length > 0) return variants.join(' | ');
  }
  return 'value';
}

function schemaSummary(value: unknown): string | undefined {
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties) return undefined;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
  );
  const fields = Object.entries(properties).map(([name, field]) => {
    const fieldRecord = asRecord(field);
    const type = fieldRecord ? schemaType(fieldRecord) : 'value';
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  });
  return fields.length > 0 ? fields.join(', ') : '{}';
}

function catalogToolLines(tool: JsonRecord, expanded: boolean): ToolLine[] {
  const enabled = tool.enabled === true;
  const name = readString(tool, 'name') ?? 'capability';
  const label = readString(tool, 'label') ?? name;
  const lines = [
    line(`${enabled ? '●' : '○'} ${label} · ${name}${enabled ? '' : ' · disabled'}`, enabled ? 'text' : 'dim'),
  ];
  if (!expanded) return lines;
  const description = readString(tool, 'description');
  const input = schemaSummary(tool.inputSchema);
  if (description) lines.push(line(description, 'muted', { indent: true }));
  if (input) lines.push(line(`input  ${input}`, 'dim', { indent: true }));
  return lines;
}

function catalogLines(snapshot: JsonRecord, expanded: boolean): ToolLine[] {
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools.map(asRecord).filter(definedRecord) : [];
  const conflicts = Array.isArray(snapshot.conflicts) ? snapshot.conflicts.map(asRecord).filter(definedRecord) : [];
  const unknownNames = Array.isArray(snapshot.unknownNames)
    ? snapshot.unknownNames.filter((name): name is string => typeof name === 'string')
    : [];
  const revision = readNumber(snapshot, 'catalogRevision');
  const summary = `${tools.length} voice ${plural(tools.length, 'capability', 'capabilities')}${
    revision === undefined ? '' : ` · catalog rev ${revision}`
  }`;
  const visible = expanded ? tools : tools.slice(0, COLLAPSED_CATALOG_ROWS);
  const lines = [line(summary, 'muted'), ...visible.flatMap((tool) => catalogToolLines(tool, expanded))];
  const hidden = tools.length - visible.length;
  if (hidden > 0) lines.push(line(`… ${hidden} more`, 'dim'));
  if (tools.length === 0) lines.push(line('No voice capabilities are currently registered.', 'dim'));

  for (const conflict of conflicts) {
    const name = readString(conflict, 'name') ?? 'capability';
    const message = readString(conflict, 'message') ?? 'Conflicting registrations.';
    lines.push(line(`! ${name} · ${message}`, 'warning'));
  }
  if (unknownNames.length > 0) lines.push(line(`? Unknown: ${unknownNames.join(', ')}`, 'warning'));
  return lines;
}

function simpleValue(value: unknown): string | undefined {
  if (typeof value === 'string') return inlineText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items = value.map(simpleValue);
    return items.every((item) => item !== undefined) ? items.join(', ') || 'none' : undefined;
  }
  return undefined;
}

function resultValueLines(value: unknown): ToolLine[] {
  const direct = simpleValue(value);
  if (direct !== undefined) return [line(direct, 'text', { indent: true })];
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, field]) => {
    const formatted = simpleValue(field);
    return formatted === undefined ? [] : [line(`${key} ${formatted}`, 'text', { indent: true })];
  });
}

function errorMessage(value: JsonRecord): string | undefined {
  return readString(asRecord(value.error), 'message');
}

function batchItemLines(item: JsonRecord, expanded: boolean): ToolLine[] {
  const name = readString(item, 'name') ?? 'capability';
  const status = readString(item, 'status') ?? 'failed';
  const style = STATUS[status] ?? FAILED;
  const message = errorMessage(item);
  const lines = [line(`${style.glyph} ${name} · ${style.label}${message ? ` · ${message}` : ''}`, style.tone)];
  if (status === 'completed' && (expanded || item.result !== undefined)) lines.push(...resultValueLines(item.result));
  return lines;
}

function batchLines(batch: JsonRecord, expanded: boolean): ToolLine[] {
  const results = Array.isArray(batch.results) ? batch.results.map(asRecord).filter(definedRecord) : [];
  const errors = Array.isArray(batch.errors) ? batch.errors.map(asRecord).filter(definedRecord) : [];
  const status = readString(batch, 'status') ?? 'failed';
  const style = STATUS[status] ?? FAILED;
  const summary = `${style.glyph} Voice batch ${style.label} · ${results.length} ${plural(results.length, 'call')}`;
  const visible = expanded ? results : results.slice(0, COLLAPSED_RESULT_ROWS);
  const lines = [
    line(summary, style.tone, { bold: true }),
    ...visible.flatMap((item) => batchItemLines(item, expanded)),
  ];
  const hidden = results.length - visible.length;
  if (hidden > 0) lines.push(line(`… ${hidden} more`, 'dim'));
  for (const error of errors) {
    const message = readString(error, 'message');
    if (message && !results.some((item) => errorMessage(item) === message)) lines.push(line(`✗ ${message}`, 'error'));
  }
  return lines;
}

function errorLines(details: JsonRecord): ToolLine[] | undefined {
  const error = asRecord(details.error);
  if (!error) return undefined;
  const message = readString(error, 'message') ?? 'Voice capability failed.';
  return [line(`✗ ${message}${error.retryable === true ? ' · retryable' : ''}`, 'error')];
}

function fallbackLines(result: ToolResultView | null, options: VoiceRenderOptions): ToolLine[] {
  const text = inlineText(textBlocks(result)[0] ?? (options.isPartial ? 'Working…' : 'No result details.'));
  const glyph = options.isPartial ? '◐' : options.isError ? '✗' : '✓';
  const tone: LineTone = options.isPartial ? 'warning' : options.isError ? 'error' : 'muted';
  return [line(`${glyph} ${text}`, tone)];
}

function narrationLines(result: ToolResultView | null, options: VoiceRenderOptions): ToolLine[] {
  const details = payload(result);
  const error = details ? errorLines(details) : undefined;
  if (error) return error;
  const outcome = readString(details, 'outcome') ?? (options.isPartial ? 'playing' : undefined);
  if (!outcome) return fallbackLines(result, options);
  const style = STATUS[outcome] ?? FAILED;
  return [line(`${style.glyph} Narration ${style.label}`, style.tone)];
}

/** The body of a voice tool card: catalog, batch, narration outcome, or the plain text. */
export function voiceResultLines(
  toolName: string,
  result: ToolResultView | null,
  options: VoiceRenderOptions,
): ToolLine[] {
  if (toolName === VOICE_NARRATE_TOOL) return narrationLines(result, options);
  const details = payload(result);
  const error = details ? errorLines(details) : undefined;
  if (error) return error;
  if (toolName === VOICE_DESCRIBE_TOOL && details && Array.isArray(details.tools)) {
    return catalogLines(details, options.expanded);
  }
  if (toolName === VOICE_USE_TOOL && details && Array.isArray(details.results)) {
    return batchLines(details, options.expanded);
  }
  return fallbackLines(result, options);
}
