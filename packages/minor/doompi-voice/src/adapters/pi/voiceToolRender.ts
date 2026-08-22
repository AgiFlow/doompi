import { VOICE_DESCRIBE_TOOL_NAME, VOICE_USE_TOOL_NAME } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { DoomToolCall, DoomToolResult, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

export type VoiceFacadeToolName = typeof VOICE_DESCRIBE_TOOL_NAME | typeof VOICE_USE_TOOL_NAME;

type JsonRecord = Record<string, unknown>;

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

interface RenderOptions {
  expanded: boolean;
  isError?: boolean;
  isPartial?: boolean;
}

interface StatusStyle {
  color: ThemeColor;
  glyph: string;
  label: string;
}

const COLLAPSED_CATALOG_ROWS = 6;
const COLLAPSED_RESULT_ROWS = 8;
const STATUS: Record<string, StatusStyle> = {
  playing: { color: 'warning', glyph: '◐', label: 'playing' },
  completed: { color: 'success', glyph: '✓', label: 'completed' },
  interrupted: { color: 'warning', glyph: '⊘', label: 'interrupted' },
  superseded: { color: 'dim', glyph: '○', label: 'superseded' },
  failed: { color: 'error', glyph: '✗', label: 'failed' },
  rejected: { color: 'error', glyph: '✗', label: 'rejected' },
  cancelled: { color: 'warning', glyph: '⊘', label: 'cancelled' },
  stopped: { color: 'warning', glyph: '■', label: 'stopped' },
  not_executed: { color: 'dim', glyph: '○', label: 'not executed' },
  preflight_failed: { color: 'error', glyph: '✗', label: 'preflight failed' },
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

function textBlocks(result: ToolResultLike): string[] {
  if (!Array.isArray(result.content)) return [];
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
    return undefined;
  }
}

function payload(result: ToolResultLike): JsonRecord | undefined {
  return asRecord(result.details) ?? parseRecord(textBlocks(result)[0]);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function requestedNames(args: Record<string, unknown>): string[] {
  const names = args.names;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
}

function requestedCalls(args: Record<string, unknown>): JsonRecord[] {
  const calls = args.calls;
  return Array.isArray(calls) ? calls.map(asRecord).filter(definedRecord) : [];
}

export function renderNarrationToolCall(args: Record<string, unknown>, theme: Theme) {
  const speech = typeof args.text === 'string' ? inlineText(args.text) : '';
  const preview = speech.length > 72 ? `${speech.slice(0, 69)}…` : speech;
  let text = renderToolHeading('voice', ' narrate', theme);
  if (preview) text += ` ${theme.fg('muted', preview)}`;
  return new DoomToolCall(text);
}

export function renderVoiceToolCall(toolName: VoiceFacadeToolName, args: Record<string, unknown>, theme: Theme) {
  if (toolName === VOICE_DESCRIBE_TOOL_NAME) {
    const names = requestedNames(args);
    let text = renderToolHeading('voice', '☰ discover', theme);
    if (names.length === 1) text += ` ${theme.fg('accent', names[0]!)}`;
    if (names.length > 1) text += ` ${theme.fg('dim', `· ${names.length} capabilities`)}`;
    return new DoomToolCall(text);
  }

  const calls = requestedCalls(args);
  let text = renderToolHeading('voice', '▶ run', theme);
  if (calls.length === 1) {
    const name = readString(calls[0], 'name');
    if (name) text += ` ${theme.fg('accent', name)}`;
  } else if (calls.length > 1) {
    text += ` ${theme.fg('dim', `· ${calls.length} capabilities`)}`;
  }
  return new DoomToolCall(text);
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
    const type = asRecord(field) ? schemaType(field as JsonRecord) : 'value';
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  });
  return fields.length > 0 ? fields.join(', ') : '{}';
}

function catalogToolLines(tool: JsonRecord, expanded: boolean, theme: Theme): string[] {
  const enabled = tool.enabled === true;
  const name = readString(tool, 'name') ?? 'capability';
  const label = readString(tool, 'label') ?? name;
  const lines = [
    `${theme.fg(enabled ? 'success' : 'dim', enabled ? '●' : '○')} ${theme.fg('text', label)} ${theme.fg('muted', `· ${name}`)}${enabled ? '' : ` ${theme.fg('dim', '· disabled')}`}`,
  ];
  if (!expanded) return lines;
  const description = readString(tool, 'description');
  const input = schemaSummary(tool.inputSchema);
  if (description) lines.push(`  ${theme.fg('muted', description)}`);
  if (input) lines.push(`  ${theme.fg('dim', `input  ${input}`)}`);
  return lines;
}

function catalogLines(snapshot: JsonRecord, expanded: boolean, theme: Theme): string[] {
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools.map(asRecord).filter(definedRecord) : [];
  const conflicts = Array.isArray(snapshot.conflicts) ? snapshot.conflicts.map(asRecord).filter(definedRecord) : [];
  const unknownNames = Array.isArray(snapshot.unknownNames)
    ? snapshot.unknownNames.filter((name): name is string => typeof name === 'string')
    : [];
  const revision = readNumber(snapshot, 'catalogRevision');
  const summary = `${tools.length} voice ${plural(tools.length, 'capability', 'capabilities')}${revision === undefined ? '' : ` · catalog rev ${revision}`}`;
  const visible = expanded ? tools : tools.slice(0, COLLAPSED_CATALOG_ROWS);
  const lines = [theme.fg('muted', summary), ...visible.flatMap((tool) => catalogToolLines(tool, expanded, theme))];
  const hidden = tools.length - visible.length;
  if (hidden > 0) lines.push(theme.fg('dim', `… ${hidden} more · ctrl+o`));
  if (tools.length === 0) lines.push(theme.fg('dim', 'No voice capabilities are currently registered.'));

  for (const conflict of conflicts) {
    const name = readString(conflict, 'name') ?? 'capability';
    const message = readString(conflict, 'message') ?? 'Conflicting registrations.';
    lines.push(`${theme.fg('warning', '!')} ${theme.fg('text', name)} ${theme.fg('warning', `· ${message}`)}`);
  }
  if (unknownNames.length > 0) {
    lines.push(`${theme.fg('warning', '?')} ${theme.fg('warning', `Unknown: ${unknownNames.join(', ')}`)}`);
  }
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

function resultValueLines(value: unknown, theme: Theme): string[] {
  const direct = simpleValue(value);
  if (direct !== undefined) return [`  ${theme.fg('toolOutput', direct)}`];
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, field]) => {
    const formatted = simpleValue(field);
    return formatted === undefined ? [] : [`  ${theme.fg('dim', `${key} `)}${theme.fg('toolOutput', formatted)}`];
  });
}

function errorMessage(value: JsonRecord): string | undefined {
  return readString(asRecord(value.error), 'message');
}

function batchItemLines(item: JsonRecord, expanded: boolean, theme: Theme): string[] {
  const name = readString(item, 'name') ?? 'capability';
  const status = readString(item, 'status') ?? 'failed';
  const style = STATUS[status] ?? STATUS.failed!;
  const message = errorMessage(item);
  const lines = [
    `${theme.fg(style.color, style.glyph)} ${theme.fg('text', name)} ${theme.fg(style.color, `· ${style.label}`)}${message ? ` ${theme.fg('muted', `· ${message}`)}` : ''}`,
  ];
  if (status === 'completed' && (expanded || item.result !== undefined)) {
    lines.push(...resultValueLines(item.result, theme));
  }
  return lines;
}

function batchLines(batch: JsonRecord, expanded: boolean, theme: Theme): string[] {
  const results = Array.isArray(batch.results) ? batch.results.map(asRecord).filter(definedRecord) : [];
  const errors = Array.isArray(batch.errors) ? batch.errors.map(asRecord).filter(definedRecord) : [];
  const status = readString(batch, 'status') ?? 'failed';
  const style = STATUS[status] ?? STATUS.failed!;
  const summary = `${style.glyph} Voice batch ${style.label} · ${results.length} ${plural(results.length, 'call')}`;
  const visible = expanded ? results : results.slice(0, COLLAPSED_RESULT_ROWS);
  const lines = [theme.fg(style.color, summary), ...visible.flatMap((item) => batchItemLines(item, expanded, theme))];
  const hidden = results.length - visible.length;
  if (hidden > 0) lines.push(theme.fg('dim', `… ${hidden} more · ctrl+o`));
  for (const error of errors) {
    const message = readString(error, 'message');
    if (message && !results.some((item) => errorMessage(item) === message)) {
      lines.push(`${theme.fg('error', '✗')} ${theme.fg('error', message)}`);
    }
  }
  return lines;
}

function errorLines(details: JsonRecord, theme: Theme): string[] | undefined {
  const error = asRecord(details.error);
  if (!error) return undefined;
  const message = readString(error, 'message') ?? 'Voice capability failed.';
  const retryable = error.retryable === true ? theme.fg('dim', ' · retryable') : '';
  return [`${theme.fg('error', '✗')} ${theme.fg('error', message)}${retryable}`];
}

function fallbackLines(result: ToolResultLike, options: RenderOptions, theme: Theme): string[] {
  const text = inlineText(textBlocks(result)[0] ?? (options.isPartial ? 'Working…' : 'No result details.'));
  const failed = options.isError || result.isError;
  const glyph = options.isPartial ? '◐' : failed ? '✗' : '✓';
  const color: ThemeColor = options.isPartial ? 'warning' : failed ? 'error' : 'success';
  return [`${theme.fg(color, glyph)} ${theme.fg(failed ? 'error' : 'muted', text)}`];
}

export function renderNarrationToolResult(
  _args: Record<string, unknown>,
  result: ToolResultLike,
  options: RenderOptions,
  theme: Theme,
) {
  const details = payload(result);
  const error = details ? errorLines(details, theme) : undefined;
  if (error) return new DoomToolResult(error, theme, { wrap: options.expanded });
  const outcome = readString(details, 'outcome') ?? (options.isPartial ? 'playing' : undefined);
  if (!outcome) return new DoomToolResult(fallbackLines(result, options, theme), theme, { wrap: options.expanded });
  const style = STATUS[outcome] ?? STATUS.failed!;
  return new DoomToolResult(
    [`${theme.fg(style.color, style.glyph)} ${theme.fg(style.color, `Narration ${style.label}`)}`],
    theme,
    { wrap: false },
  );
}

export function renderVoiceToolResult(
  toolName: VoiceFacadeToolName,
  _args: Record<string, unknown>,
  result: ToolResultLike,
  options: RenderOptions,
  theme: Theme,
) {
  const details = payload(result);
  let lines: string[];
  const error = details ? errorLines(details, theme) : undefined;
  if (error) lines = error;
  else if (toolName === VOICE_DESCRIBE_TOOL_NAME && details && Array.isArray(details.tools)) {
    lines = catalogLines(details, options.expanded, theme);
  } else if (toolName === VOICE_USE_TOOL_NAME && details && Array.isArray(details.results)) {
    lines = batchLines(details, options.expanded, theme);
  } else {
    lines = fallbackLines(result, options, theme);
  }
  return new DoomToolResult(lines, theme, { wrap: options.expanded });
}
