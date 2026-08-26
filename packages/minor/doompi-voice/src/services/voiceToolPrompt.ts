/**
 * The model-facing half of the voice façade, opposite `adapters/pi/voiceToolRender.ts`.
 *
 * Pi hands `AgentToolResult.content` to the model and keeps `details` for logs and the
 * TUI. The catalog token lives in the snapshot, so a result that only puts the snapshot
 * in `details` leaves the model with no legitimate source for the one value
 * `use_voice_tools` requires, and every batch is rejected as a stale catalog. These
 * formatters are what put the token, the capability schemas, and the per-call results
 * where the model can actually read them.
 *
 * XML rather than prose because that is what the rest of the distribution already uses
 * for injected model-facing blocks (`<available_skills>` in Team, `<goal_id>` in Goal),
 * and because an opaque token has to survive being copied back verbatim.
 */

import type {
  VoiceToolBatchItemResult,
  VoiceToolBatchResult,
  VoiceToolCatalogEntry,
  VoiceToolCatalogSnapshot,
  VoiceToolConflictDiagnostic,
  VoiceToolErrorPayload,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';

/**
 * The ceiling for one formatted block.
 *
 * A single contributed schema may be up to `VOICE_TOOL_MAX_SCHEMA_BYTES` (32 KB) and a
 * detailed request may name 16 of them, so this cap rather than the per-schema one is
 * what actually bounds the text.
 */
const MAX_BLOCK_LENGTH = 8_000;
/**
 * The ceiling for the digest carried in the `describe_voice_tools` description.
 *
 * Far tighter than `MAX_BLOCK_LENGTH` because this text is part of the tool schema
 * rather than a result: it rides every request for the life of the session, where a
 * catalog block is paid for once by the call that asked for it.
 */
const MAX_DIGEST_LENGTH = 2_000;
/** Head room kept back from the cap so the truncation notice itself always fits. */
const TRUNCATION_RESERVE = 200;

const USAGE_NEXT_STEP =
  'Call describe_voice_tools with names to read the input_schema of the capabilities you intend to run, then pass this exact catalog_token to use_voice_tools.';
const USAGE_READY =
  'Pass this exact catalog_token to use_voice_tools and build each call input from the input_schema above.';
const USAGE_EMPTY = 'No voice capabilities are registered for this session.';
const USAGE_DISABLED = 'Disabled capabilities cannot run until autonomous voice is active.';
const USAGE_TRUNCATED = 'Narrow the request with the names parameter to see the capabilities left out here.';

/**
 * Escapes a text node.
 *
 * Quotes are deliberately left alone: `input_schema` and `result` carry JSON, and
 * turning every quote in them into `&quot;` would leave the model reading an entity
 * soup instead of a schema. Kept local rather than shared: Goal and Team each carry
 * their own copy, and a cross-package export for this is not worth the boundary.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escapes an attribute value, where a quote would end the attribute.
 *
 * Needed because a conflict diagnostic carries a free-form `name` with no pattern
 * constraint, and that name is emitted as an attribute.
 */
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * Serializes a payload the contracts layer has already round-tripped through
 * `cloneJson`. The fallback covers the residual case where a value arrives without that
 * guarantee, so one unserializable capability result cannot blank the whole block.
 */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"<unserializable>"';
  }
}

function element(tag: string, text: string, indent = '  '): string {
  return `${indent}<${tag}>${escapeText(text)}</${tag}>`;
}

/**
 * Joins fixed head and tail lines with as many whole blocks as the cap allows.
 *
 * Blocks are dropped from the end and counted rather than cut mid-element: a half
 * serialized `<capability>` would read as a complete one that happens to lack a schema.
 */
function assemble(
  head: readonly string[],
  blocks: readonly string[][],
  tail: readonly string[],
  limit = MAX_BLOCK_LENGTH,
): string {
  let budget = limit - [...head, ...tail].join('\n').length - TRUNCATION_RESERVE;
  const kept: string[] = [];
  let index = 0;
  for (; index < blocks.length; index += 1) {
    const block = blocks[index] ?? [];
    const cost = block.join('\n').length + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(...block);
  }
  const dropped = blocks.length - index;
  const notice =
    dropped > 0 ? [`  <truncated capabilities="${dropped}">${escapeText(USAGE_TRUNCATED)}</truncated>`] : [];
  return [...head, ...kept, ...notice, ...tail].join('\n');
}

function capabilityBlock(tool: VoiceToolCatalogEntry, detailed: boolean): string[] {
  const open = `  <capability name="${escapeAttribute(tool.name)}" enabled="${tool.enabled}">`;
  if (!detailed) return [`${open}${escapeText(tool.description)}</capability>`];
  return [
    open,
    element('label', tool.label, '    '),
    element('source', tool.source, '    '),
    element('description', tool.description, '    '),
    element('input_schema', jsonText(tool.inputSchema), '    '),
    '  </capability>',
  ];
}

/**
 * The capability list carried in the `describe_voice_tools` tool description.
 *
 * Without it the model has no lexical bridge to the façade: the contributed names are
 * the only place `minor_mode` or `switch_domains` is written down, and they reach the
 * model solely in a result it has no reason to ask for. Asking the agent to switch a
 * minor mode then matches nothing and the façade goes unused.
 *
 * Deliberately narrower than `formatCatalog`. No `catalog_token`, because the token is
 * session-scoped and a description is cached across the session; the model must still
 * take it from a live result. No `enabled`, because that flips on every activation and
 * would re-register the tool, and therefore rebuild the system prompt, each time.
 * Returns `undefined` for an empty catalog so the caller keeps the protocol text alone
 * rather than advertising a header with nothing under it.
 */
export function formatCatalogDigest(tools: readonly VoiceToolCatalogEntry[]): string | undefined {
  if (tools.length === 0) return undefined;
  return assemble(
    ['<voice_tool_catalog>'],
    tools.map((tool) => [
      `  <capability name="${escapeAttribute(tool.name)}">${escapeText(tool.description)}</capability>`,
    ]),
    ['</voice_tool_catalog>'],
    MAX_DIGEST_LENGTH,
  );
}

function conflictLine(conflict: VoiceToolConflictDiagnostic): string {
  return `  <conflict name="${escapeAttribute(conflict.name)}">${escapeText(conflict.message)}</conflict>`;
}

function errorLine(error: VoiceToolErrorPayload, indent: string): string {
  return `${indent}<error code="${escapeAttribute(error.code)}" retryable="${error.retryable === true}">${escapeText(error.message)}</error>`;
}

/**
 * The `describe_voice_tools` result.
 *
 * `detailed` follows the request rather than the catalog: a bare call is discovery and
 * costs one line per capability, and naming capabilities is what buys their schemas.
 */
export function formatCatalog(snapshot: VoiceToolCatalogSnapshot, detailed: boolean): string {
  const head = ['<voice_tool_catalog>', element('catalog_token', snapshot.catalogToken)];
  const empty = snapshot.tools.length === 0;
  const usage = [empty ? USAGE_EMPTY : detailed ? USAGE_READY : USAGE_NEXT_STEP];
  if (snapshot.tools.some((tool) => !tool.enabled)) usage.push(USAGE_DISABLED);
  const tail = [
    ...(empty ? ['  <capabilities_empty/>'] : []),
    ...snapshot.conflicts.map(conflictLine),
    ...snapshot.unknownNames.map((name) => element('unknown_name', name)),
    ...usage.map((entry) => element('usage', entry)),
    '</voice_tool_catalog>',
  ];
  return assemble(
    head,
    snapshot.tools.map((tool) => capabilityBlock(tool, detailed)),
    tail,
  );
}

function callBlock(item: VoiceToolBatchItemResult): string[] {
  const open = `  <call index="${item.index}" name="${escapeAttribute(item.name)}" status="${escapeAttribute(item.status)}"`;
  const body = [
    ...(item.result === undefined ? [] : [element('result', jsonText(item.result), '    ')]),
    ...(item.error ? [errorLine(item.error, '    ')] : []),
  ];
  return body.length === 0 ? [`${open}/>`] : [`${open}>`, ...body, '  </call>'];
}

/**
 * The `use_voice_tools` result.
 *
 * The fresh token is emitted even on rejection: a batch turned away as stale can then be
 * retried directly, without a second describe round trip.
 */
export function formatBatch(result: VoiceToolBatchResult): string {
  const head = [
    `<voice_tool_batch status="${escapeAttribute(result.status)}">`,
    element('catalog_token', result.catalogToken),
    ...(result.errors ?? []).map((error) => errorLine(error, '  ')),
  ];
  return assemble(head, result.results.map(callBlock), ['</voice_tool_batch>']);
}

/** The façade's own failures, which never reach a catalog or a batch. */
export function formatError(error: VoiceToolErrorPayload): string {
  return `<voice_tool_error code="${escapeAttribute(error.code)}" retryable="${error.retryable === true}">${escapeText(error.message)}</voice_tool_error>`;
}
