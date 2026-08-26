import type {
  AssistantTranscriptItem,
  JsonValue,
  SessionPhase,
  SessionSnapshot,
  ThinkingLevel,
  ToolTranscriptItem,
  TranscriptItem,
  TranscriptProgress,
  UserTranscriptItem,
} from '@earendil-works/pi-protocol';
import type { SessionFrame } from '../types/session.ts';

const THINKING_LEVELS = new Set<string>(['off', 'minimal', 'low', 'medium', 'high']);
const STOP_REASONS = new Set<string>(['stop', 'length', 'toolUse']);
const UNKNOWN_MODEL = { provider: 'unknown', id: 'unknown' };

/**
 * What one agent frame changed.
 *
 * A frame can do both: finishing a message publishes the completed item as
 * progress and appends it to the authoritative transcript.
 */
export interface TranscriptReduction {
  /** Present when the frame changed authoritative state. */
  snapshot?: SessionSnapshot;
  /** Present when the frame produced transient activity. */
  progress?: TranscriptProgress;
}

export interface RpcTranscript {
  snapshot(): SessionSnapshot;
  phase(): SessionPhase;
  apply(frame: SessionFrame): TranscriptReduction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Coerces to the protocol's JSON subset, which rejects undefined and non-plain objects. */
function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry));
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

function thinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : fallback;
}

function modelRef(value: unknown): { provider: string; id: string } {
  if (!isRecord(value)) return UNKNOWN_MODEL;
  const provider = text(value.provider);
  const id = text(value.id);
  return provider && id ? { provider, id } : UNKNOWN_MODEL;
}

/** Maps pi-ai assistant content onto the protocol's closed part union. */
function assistantContent(value: unknown): AssistantTranscriptItem['content'] {
  if (!Array.isArray(value)) return [];
  const parts: AssistantTranscriptItem['content'] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === 'text') parts.push({ type: 'text', text: text(part.text) });
    else if (part.type === 'thinking') {
      parts.push({
        type: 'thinking',
        thinking: text(part.thinking),
        ...(part.redacted === true ? { redacted: true } : {}),
      });
    } else if (part.type === 'toolCall') {
      const toolCallId = text(part.id, text(part.toolCallId));
      const toolName = text(part.name, text(part.toolName));
      if (!toolCallId || !toolName) continue;
      parts.push({ type: 'toolCall', toolCallId, toolName, input: normalizeJson(part.arguments ?? part.input) });
    }
  }
  return parts;
}

type AssistantContentPart = AssistantTranscriptItem['content'][number];

/** Applies Pi RPC's delta-only assistant event to the live protocol item. */
function applyAssistantEvent(
  content: AssistantTranscriptItem['content'],
  value: unknown,
): AssistantTranscriptItem['content'] {
  if (!isRecord(value) || !Number.isInteger(value.contentIndex) || (value.contentIndex as number) < 0) return content;
  const index = value.contentIndex as number;
  const parts: Array<AssistantContentPart | undefined> = [...content];
  const existing = parts[index];
  switch (value.type) {
    case 'text_start':
      parts[index] = existing?.type === 'text' ? existing : { type: 'text', text: '' };
      break;
    case 'text_delta':
      parts[index] = { type: 'text', text: (existing?.type === 'text' ? existing.text : '') + text(value.delta) };
      break;
    case 'text_end':
      parts[index] = { type: 'text', text: text(value.content, existing?.type === 'text' ? existing.text : '') };
      break;
    case 'thinking_start':
      parts[index] = existing?.type === 'thinking' ? existing : { type: 'thinking', thinking: '' };
      break;
    case 'thinking_delta':
      parts[index] = {
        type: 'thinking',
        thinking: (existing?.type === 'thinking' ? existing.thinking : '') + text(value.delta),
      };
      break;
    case 'thinking_end':
      parts[index] = {
        type: 'thinking',
        thinking: text(value.content, existing?.type === 'thinking' ? existing.thinking : ''),
      };
      break;
    case 'toolcall_start': {
      const toolCallId = text(value.id);
      const toolName = text(value.toolName);
      if (toolCallId && toolName) parts[index] = { type: 'toolCall', toolCallId, toolName, input: {} };
      break;
    }
    case 'toolcall_end': {
      const completed = assistantContent([value.toolCall])[0];
      if (completed) parts[index] = completed;
      break;
    }
  }
  return parts.filter((part): part is AssistantContentPart => part !== undefined);
}

/** Maps a user or tool payload onto the protocol's text-and-image union. */
function plainContent(value: unknown): UserTranscriptItem['content'] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  const parts: UserTranscriptItem['content'] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === 'text') parts.push({ type: 'text', text: text(part.text) });
    else if (part.type === 'image') {
      const data = text(part.data);
      const mimeType = text(part.mimeType);
      if (data && mimeType) parts.push({ type: 'image', data, mimeType });
    }
  }
  return parts;
}

export interface RpcTranscriptOptions {
  id: string;
  cwd: string;
  name?: string;
  /**
   * Supplies every timestamp this projection stamps.
   *
   * Required rather than defaulted: a service that reaches for the clock is
   * one a test cannot pin, and the snapshot's timestamps are compared.
   */
  now: () => number;
}

/**
 * Projects Pi's rpc event stream onto the protocol's session model.
 *
 * The protocol is snapshot-authoritative: the snapshot is the truth and
 * progress is a transient hint that must never be reduced into it. That split
 * is the reason this exists at all, because Pi's rpc stream makes no such
 * distinction and reports a running message the same way it reports a settled
 * one. Frames with no protocol meaning reduce to nothing rather than being
 * forced into a shape the schema would reject.
 */
export function createRpcTranscript(options: RpcTranscriptOptions): RpcTranscript {
  const now = options.now;
  const created = now();
  let snapshot: SessionSnapshot = {
    id: options.id,
    cwd: options.cwd,
    createdAt: created,
    updatedAt: created,
    phase: 'idle',
    model: UNKNOWN_MODEL,
    thinkingLevel: 'medium',
    attached: false,
    locked: false,
    revision: 0,
    transcript: [],
    queuedSteer: [],
    queuedSteerCount: 0,
    ...(options.name === undefined ? {} : { name: options.name }),
  };
  /** Assistant messages still streaming, by message id. */
  const streaming = new Map<string, AssistantTranscriptItem>();
  let activeAssistantId: string | undefined;
  /** Tool calls still running, by tool call id. */
  const running = new Map<string, ToolTranscriptItem>();

  const commit = (updates: Partial<SessionSnapshot>): SessionSnapshot => {
    snapshot = { ...snapshot, ...updates, revision: snapshot.revision + 1, updatedAt: now() };
    return snapshot;
  };

  const append = (item: TranscriptItem): SessionSnapshot => commit({ transcript: [...snapshot.transcript, item] });

  /**
   * Appends unless the transcript already holds that id.
   *
   * A user message reaches this twice: once as the message the agent started,
   * and again when the session journals it. Only one belongs in the
   * transcript, and the id is what decides which arrival was first.
   */
  const appendUnique = (item: TranscriptItem): SessionSnapshot | undefined =>
    snapshot.transcript.some((existing) => existing.id === item.id) ? undefined : append(item);

  /**
   * A user message keyed by when it was written.
   *
   * pi-ai gives a user message no id of its own, so the timestamp is the only
   * thing both arrivals of the same message agree on.
   */
  const userFrom = (
    message: Record<string, unknown>,
    fallbackId: string,
    fallbackTimestamp?: number,
  ): UserTranscriptItem | undefined => {
    const content = plainContent(message.content);
    if (content.length === 0) return undefined;
    const stamp = typeof message.timestamp === 'number' ? message.timestamp : fallbackTimestamp;
    return {
      id: stamp === undefined ? fallbackId : `user-${stamp}`,
      role: 'user',
      content,
      timestamp: stamp ?? now(),
    };
  };

  const assistantFrom = (message: unknown, id: string): AssistantTranscriptItem => ({
    id,
    role: 'assistant',
    content: assistantContent(isRecord(message) ? message.content : undefined),
    model: isRecord(message) ? modelRef(message.model ?? snapshot.model) : snapshot.model,
    status: 'streaming',
    timestamp: now(),
  });

  return {
    snapshot: () => structuredClone(snapshot),
    phase: () => snapshot.phase,
    apply(frame) {
      const type = text(frame.type);
      switch (type) {
        case 'agent_start':
          return { snapshot: commit({ phase: 'turn' }) };
        case 'agent_settled':
          return { snapshot: commit({ phase: 'idle' }) };
        case 'compaction_start':
          return { snapshot: commit({ phase: 'compaction' }) };
        case 'compaction_end':
          return { snapshot: commit({ phase: 'idle' }) };
        case 'auto_retry_start':
          return { snapshot: commit({ phase: 'retry' }) };
        case 'auto_retry_end':
          return { snapshot: commit({ phase: 'turn' }) };
        case 'thinking_level_changed':
          return { snapshot: commit({ thinkingLevel: thinkingLevel(frame.level, snapshot.thinkingLevel) }) };
        case 'session_info_changed': {
          const name = text(frame.name);
          return { snapshot: commit(name ? { name } : {}) };
        }
        case 'queue_update': {
          const steering = Array.isArray(frame.steering) ? frame.steering : [];
          const queuedSteer: UserTranscriptItem[] = steering.map((entry, index) => ({
            id: `steer-${snapshot.revision}-${index}`,
            role: 'user',
            content: [{ type: 'text', text: text(entry) }],
            timestamp: now(),
          }));
          return { snapshot: commit({ queuedSteer, queuedSteerCount: queuedSteer.length }) };
        }
        case 'message_start': {
          const message = isRecord(frame.message) ? frame.message : {};
          // These frames carry whichever message the agent started, and that
          // includes the one the user just sent. Treating every message as the
          // assistant's is what puts a prompt in the agent's voice.
          if (message.role === 'user') {
            const item = userFrom(message, `user-${snapshot.revision}`);
            if (!item) return {};
            const committed = appendUnique(item);
            return committed ? { snapshot: committed } : {};
          }
          if (message.role !== 'assistant') return {};
          const id = text(message.id, `assistant-${snapshot.revision}`);
          const item = assistantFrom(frame.message, id);
          streaming.set(id, item);
          activeAssistantId = id;
          return { progress: { type: 'item_started', item } };
        }
        case 'message_update': {
          const id = text(isRecord(frame.message) ? frame.message.id : undefined, activeAssistantId);
          const existing = streaming.get(id);
          if (!existing) return {};
          const item: AssistantTranscriptItem = {
            ...existing,
            content: isRecord(frame.message)
              ? assistantContent(frame.message.content)
              : applyAssistantEvent(existing.content, frame.assistantMessageEvent),
          };
          streaming.set(id, item);
          return { progress: { type: 'item_updated', item } };
        }
        case 'message_end': {
          const ended = isRecord(frame.message) ? frame.message : {};
          if (ended.role === 'user') {
            const item = userFrom(ended, `user-${snapshot.revision}`);
            if (!item) return {};
            const committed = appendUnique(item);
            return committed ? { snapshot: committed } : {};
          }
          // A tool result closes here too, but the transcript builds tool items
          // from the execution frames, which carry the call as well as its result.
          if (ended.role !== 'assistant') return {};
          const id = text(ended.id, activeAssistantId);
          const started = streaming.get(id) ?? assistantFrom(frame.message, id || `assistant-${snapshot.revision}`);
          streaming.delete(started.id);
          if (activeAssistantId === started.id) activeAssistantId = undefined;
          const message = ended;
          const stopReason = text(message.stopReason);
          const errorMessage = text(message.errorMessage);
          const base = {
            ...started,
            content: assistantContent(message.content ?? started.content),
          };
          const item: AssistantTranscriptItem =
            stopReason === 'aborted'
              ? { ...base, status: 'aborted', stopReason: 'aborted', ...(errorMessage ? { errorMessage } : {}) }
              : stopReason === 'error'
                ? { ...base, status: 'error', stopReason: 'error', ...(errorMessage ? { errorMessage } : {}) }
                : {
                    ...base,
                    status: 'complete',
                    stopReason: STOP_REASONS.has(stopReason) ? (stopReason as 'stop' | 'length' | 'toolUse') : 'stop',
                  };
          return { snapshot: append(item), progress: { type: 'item_finished', item } };
        }
        case 'tool_execution_start': {
          const toolCallId = text(frame.toolCallId);
          const toolName = text(frame.toolName);
          if (!toolCallId || !toolName) return {};
          const item: ToolTranscriptItem = {
            id: toolCallId,
            role: 'tool',
            toolCallId,
            toolName,
            input: normalizeJson(frame.args),
            content: [],
            status: 'running',
            isError: false,
            timestamp: now(),
          };
          running.set(toolCallId, item);
          return { progress: { type: 'item_started', item } };
        }
        case 'tool_execution_update': {
          const existing = running.get(text(frame.toolCallId));
          if (!existing) return {};
          // The partial result is DoomPi's own view of the call in flight, and
          // `details` is the only field on a tool item the schema leaves open.
          const item: ToolTranscriptItem = { ...existing, details: normalizeJson(frame.partialResult) };
          running.set(existing.toolCallId, item);
          return { progress: { type: 'item_updated', item } };
        }
        case 'tool_execution_end': {
          const toolCallId = text(frame.toolCallId);
          const existing = running.get(toolCallId);
          if (!existing) return {};
          running.delete(toolCallId);
          const result = isRecord(frame.result) ? frame.result : {};
          const isError = frame.isError === true;
          const item: ToolTranscriptItem = {
            ...existing,
            content: plainContent(result.content ?? result.output),
            ...(result.details === undefined ? {} : { details: normalizeJson(result.details) }),
            ...(isError ? { status: 'error', isError: true } : { status: 'complete', isError: false }),
          };
          return { snapshot: append(item), progress: { type: 'item_finished', item } };
        }
        case 'entry_appended': {
          const entry = isRecord(frame.entry) ? frame.entry : undefined;
          // Only a journalled user message has a protocol shape. Everything
          // else DoomPi journals travels on its own channel, where it keeps
          // the vocabulary the schema has no room for.
          if (!entry || entry.type !== 'message') return {};
          const message = isRecord(entry.message) ? entry.message : undefined;
          if (!message || message.role !== 'user') return {};
          // Keyed the same way the started message was, so whichever arrival
          // came first is the one the transcript keeps.
          const item = userFrom(
            message,
            text(entry.id, `user-${snapshot.revision}`),
            typeof entry.timestamp === 'number' ? entry.timestamp : undefined,
          );
          if (!item) return {};
          const committed = appendUnique(item);
          return committed ? { snapshot: committed } : {};
        }
        case 'response':
          return frame.command === 'get_state' ? applyState(frame.data) : {};
        default:
          return {};
      }
    },
  };

  function applyState(data: unknown): TranscriptReduction {
    if (!isRecord(data)) return {};
    const streamingNow = data.isStreaming === true;
    const compacting = data.isCompacting === true;
    const name = text(data.sessionName);
    return {
      snapshot: commit({
        model: modelRef(data.model),
        thinkingLevel: thinkingLevel(data.thinkingLevel, snapshot.thinkingLevel),
        phase: compacting ? 'compaction' : streamingNow ? 'turn' : 'idle',
        ...(name ? { name } : {}),
      }),
    };
  }
}
