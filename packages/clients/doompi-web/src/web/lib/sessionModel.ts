import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';
import {
  CONTEXT_ENTRY_TYPE,
  type ContextProjection,
  DIALOG_ANSWERED_TYPE,
  MINOR_MODE_ENTRY_TYPE,
  type MinorModeProjection,
} from '../../types/hub.ts';
import { BUILTIN_COMMANDS } from './commands.ts';

export type EntryKind = 'user' | 'assistant' | 'tool' | 'notice';

export interface UserImage {
  data: string;
  mimeType: string;
}

export interface UserEntry {
  kind: 'user';
  id: string;
  text: string;
  images?: UserImage[];
}

export interface AssistantEntry {
  kind: 'assistant';
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
}

export interface ToolEntry {
  kind: 'tool';
  id: string;
  toolCallId: string;
  name: string;
  /** The call arguments as the frame carried them, for a plugin's own renderer. */
  args: Record<string, unknown>;
  argSummary: string;
  /** The newest result, partial while running; null before the tool produced any. */
  result: ToolResultView | null;
  output: string;
  isError: boolean;
  running: boolean;
}

export interface NoticeEntry {
  kind: 'notice';
  id: string;
  text: string;
  tone: 'info' | 'error';
}

export interface SettledEntry {
  kind: 'settled';
  id: string;
  tools: number;
}

export interface QueuedEntry {
  kind: 'queued';
  id: string;
  text: string;
  /** How Pi must receive this entry when the browser rebuilds the queue after deleting one item. */
  delivery?: 'steer' | 'followUp';
  images?: UserImage[];
}

export type TimelineEntry = UserEntry | AssistantEntry | ToolEntry | NoticeEntry | SettledEntry | QueuedEntry;

export interface SessionStats {
  cost: number;
  totalTokens: number;
  contextPercent: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
}

export interface AgentInfo {
  model: string;
  /** The provider Pi resolved the model under; set_model needs both halves. */
  provider: string;
  thinkingLevel: string;
  sessionId: string;
  sessionName: string;
  messageCount: number;
  isStreaming: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
}

/** One model the session can switch to, as get_available_models lists it. */
export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export type DialogMethod = 'select' | 'confirm' | 'input' | 'editor';

export interface DialogRequest {
  id: string;
  method: DialogMethod;
  title: string;
  message: string;
  options: string[];
  placeholder: string;
  prefill: string;
}

export interface EditorTextRequest {
  id: string;
  text: string;
}

export interface SessionState {
  entries: TimelineEntry[];
  /** Running tool frames kept outside the protocol-owned transcript so prompt plugins can claim their dialogs. */
  activeTools: ToolEntry[];
  /**
   * Footer status entries keyed as the publishing extension named them, raw so
   * the colour survives. A key that is absent means the package is not in this
   * composition; a key holding an empty string means it is loaded but off.
   */
  statuses: Record<string, string>;
  /** Widget keys the session has announced, the only signal some modes give. */
  widgets: string[];
  streaming: boolean;
  settled: boolean;
  stats: SessionStats | null;
  agent: AgentInfo | null;
  commands: CommandInfo[];
  /** Models the session offered, empty until the picker asks. */
  models: ModelChoice[];
  /** Thinking levels the current model accepts, empty until the picker asks. */
  thinkingLevels: string[];
  dialog: DialogRequest | null;
  /** Latest fire-and-forget editor replacement requested by a session extension. */
  editorTextRequest: EditorTextRequest | null;
  /** The runtime's minor-mode catalog as last journaled, or null before it reports. */
  minorModes: MinorModeProjection | null;
  /** What the session is composed of, as last journaled, or null before it reports. */
  context: ContextProjection | null;
  /** Tool calls seen since the current run began, reported when it settles. */
  toolsThisRun: number;
  /**
   * Journal entry ids already folded into the timeline. The hub re-reads the
   * journal on every attach, so a reconnect replays entries this page already
   * has; folding by id is what keeps a restored transcript from doubling.
   */
  restoredIds: string[];
  /**
   * Prompts this page put on screen before the journal recorded them, newest
   * last. The cockpit shows your message the moment you send it, but the
   * journal is what carries every message, including the ones an extension
   * sends on your behalf. Matching a journal message against this list is what
   * lets both appear exactly once.
   */
  pendingUserEntries: { id: string; text: string; images?: UserImage[] }[];
  /**
   * Prompts an authoritative transcript already folded into the entry this page
   * rendered, newest last.
   *
   * A prompt reaches the timeline from two directions, Pi's protocol snapshot
   * and the session journal, and whichever lands first consumes the pending
   * record. Without this the second arrival has nothing to match and appends a
   * second copy of the message, which is what a reader sees when transcript
   * ownership returns to the journal mid-session.
   */
  reconciledUserEntries: { id: string; text: string; images?: UserImage[] }[];
  /** Stable local ids for optimistic prompts after Pi publishes their canonical transcript entries. */
  protocolUserEntryIds: Record<string, string>;
  nextId: number;
}

export const initialSessionState: SessionState = {
  entries: [],
  activeTools: [],
  statuses: {},
  widgets: [],
  streaming: false,
  settled: false,
  stats: null,
  agent: null,
  commands: [],
  models: [],
  thinkingLevels: [],
  dialog: null,
  editorTextRequest: null,
  minorModes: null,
  context: null,
  toolsThisRun: 0,
  restoredIds: [],
  pendingUserEntries: [],
  reconciledUserEntries: [],
  protocolUserEntryIds: {},
  nextId: 1,
};

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Joins the text blocks of a Pi content array, ignoring non-text parts. */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && block.type === 'text' ? asString(block.text) : ''))
    .filter(Boolean)
    .join('');
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isSupportedImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Keeps only image blocks the cockpit can safely render as data URLs. */
export function imagesFromContent(content: unknown): UserImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'image') return [];
    const data = asString(block.data);
    const mimeType = asString(block.mimeType);
    return data && isSupportedImageMimeType(mimeType) ? [{ data, mimeType }] : [];
  });
}

/** A one-line description of a tool call, good enough for a card header. */
export function summariseArgs(args: unknown): string {
  if (!isRecord(args)) return '';
  for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const keys = Object.keys(args);
  return keys.length > 0 ? keys.join(', ') : '';
}

function withEntry(state: SessionState, entry: TimelineEntry): SessionState {
  return { ...state, entries: [...state.entries, entry], nextId: state.nextId + 1 };
}

function replaceEntry(state: SessionState, id: string, next: TimelineEntry): SessionState {
  return { ...state, entries: state.entries.map((entry) => (entry.id === id ? next : entry)) };
}

function openAssistant(state: SessionState): { state: SessionState; entry: AssistantEntry } {
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === 'assistant' && last.streaming) return { state, entry: last };
  const entry: AssistantEntry = {
    kind: 'assistant',
    id: `a${state.nextId}`,
    text: '',
    thinking: '',
    streaming: true,
  };
  return { state: withEntry(state, entry), entry };
}

function applyAssistantDelta(state: SessionState, event: Frame): SessionState {
  const type = asString(event.type);
  if (type !== 'text_delta' && type !== 'thinking_delta' && type !== 'text_start' && type !== 'thinking_start') {
    return state;
  }
  const opened = openAssistant(state);
  const delta = asString(event.delta);
  if (!delta) return opened.state;
  const next: AssistantEntry =
    type === 'thinking_delta'
      ? { ...opened.entry, thinking: opened.entry.thinking + delta }
      : { ...opened.entry, text: opened.entry.text + delta };
  return replaceEntry(opened.state, opened.entry.id, next);
}

function closeAssistant(state: SessionState, message: unknown): SessionState {
  const index = state.entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.streaming);
  if (index === -1) return state;
  const current = state.entries[index] as AssistantEntry;
  const finalText = isRecord(message) ? textFromContent(message.content) : '';
  const next: AssistantEntry = {
    ...current,
    text: finalText.length > current.text.length ? finalText : current.text,
    streaming: false,
  };
  const entries = [...state.entries];
  entries[index] = next;
  return { ...state, entries };
}

function toolEntryFromStart(frame: Frame, id: string): ToolEntry {
  return {
    kind: 'tool',
    id,
    toolCallId: asString(frame.toolCallId),
    name: asString(frame.toolName, 'tool'),
    args: isRecord(frame.args) ? frame.args : {},
    argSummary: summariseArgs(frame.args),
    result: null,
    output: '',
    isError: false,
    running: true,
  };
}

function applyToolStart(state: SessionState, frame: Frame): SessionState {
  const opened = withEntry(closeAssistant(state, undefined), toolEntryFromStart(frame, `t${state.nextId}`));
  return { ...opened, toolsThisRun: opened.toolsThisRun + 1 };
}

/**
 * The result a tool frame carries, kept whole: the text blocks feed the
 * default card, and the content plus details reach the owning plugin's
 * renderer untouched, the way Pi hands them to a TUI renderResult.
 */
function toolResult(raw: unknown): ToolResultView | null {
  if (!isRecord(raw)) return null;
  return { content: Array.isArray(raw.content) ? raw.content : [], details: raw.details };
}

function updateTool(state: SessionState, toolCallId: string, patch: Partial<ToolEntry>): SessionState {
  const index = state.entries.findLastIndex((entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId);
  if (index === -1) return state;
  const entries = [...state.entries];
  entries[index] = { ...(entries[index] as ToolEntry), ...patch };
  return { ...state, entries };
}

/** Commands the picker issues; a refusal must show, or the chip just stays put. */
const PICKER_COMMANDS = new Set(['set_model', 'set_thinking_level']);

function modelChoice(value: unknown): ModelChoice | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.provider !== 'string') return undefined;
  return {
    provider: value.provider,
    id: value.id,
    name: asString(value.name, value.id),
    reasoning: value.reasoning === true,
  };
}

function applyResponse(state: SessionState, frame: Frame): SessionState {
  const command = asString(frame.command);
  if (frame.success === false && PICKER_COMMANDS.has(command)) {
    return withEntry(state, {
      kind: 'notice',
      id: `n${state.nextId}`,
      text: asString(frame.error, `The agent refused ${command}.`),
      tone: 'error',
    });
  }
  const data = frame.data;
  if (!isRecord(data)) return state;

  if (command === 'get_state') {
    const model = isRecord(data.model) ? asString(data.model.id ?? data.model.name, 'unknown') : 'unknown';
    const provider = isRecord(data.model) ? asString(data.model.provider) : '';
    return {
      ...state,
      agent: {
        model,
        provider,
        thinkingLevel: asString(data.thinkingLevel, 'unknown'),
        sessionId: asString(data.sessionId),
        sessionName: asString(data.sessionName),
        messageCount: asNumber(data.messageCount) ?? 0,
        isStreaming: data.isStreaming === true,
      },
    };
  }

  if (command === 'get_available_models') {
    const models = Array.isArray(data.models) ? data.models.map(modelChoice).filter((m) => m !== undefined) : [];
    return { ...state, models };
  }

  if (command === 'get_available_thinking_levels') {
    const levels = Array.isArray(data.levels) ? data.levels.filter((level) => typeof level === 'string') : [];
    return { ...state, thinkingLevels: levels };
  }

  // Pi echoes the model it switched to; get_state follows for the rest.
  if (command === 'set_model' && state.agent) {
    const chosen = modelChoice(data);
    return chosen ? { ...state, agent: { ...state.agent, model: chosen.id, provider: chosen.provider } } : state;
  }

  if (command === 'get_session_stats') {
    const tokens = isRecord(data.tokens) ? asNumber(data.tokens.total) : null;
    const usage = isRecord(data.contextUsage) ? data.contextUsage : undefined;
    return {
      ...state,
      stats: {
        cost: asNumber(data.cost) ?? 0,
        totalTokens: tokens ?? 0,
        contextPercent: usage ? asNumber(usage.percent) : null,
        contextTokens: usage ? asNumber(usage.tokens) : null,
        contextWindow: usage ? asNumber(usage.contextWindow) : null,
      },
    };
  }

  if (command === 'get_commands') {
    const raw = Array.isArray(data.commands) ? data.commands : [];
    const reported = raw
      .filter(isRecord)
      .map((entry) => ({ name: asString(entry.name), description: asString(entry.description) }))
      .filter((entry) => entry.name.length > 0);
    // Pi does not report its own built-ins here, so the cockpit adds the ones
    // it can run. An extension that claims the same name keeps it: that one
    // reaches the session through the prompt path and is what the user gets.
    const claimed = new Set(reported.map((entry) => entry.name));
    const commands = [...reported, ...BUILTIN_COMMANDS.filter((entry) => !claimed.has(entry.name))];
    return { ...state, commands };
  }

  return state;
}

function applyStatus(state: SessionState, frame: Frame): SessionState {
  const key = asString(frame.statusKey);
  if (!key) return state;
  const text = typeof frame.statusText === 'string' ? frame.statusText : '';
  if (state.statuses[key] === text) return state;
  return { ...state, statuses: { ...state.statuses, [key]: text } };
}

function applyWidget(state: SessionState, frame: Frame): SessionState {
  const key = asString(frame.widgetKey);
  if (!key) return state;
  const present = Array.isArray(frame.widgetLines) && frame.widgetLines.length > 0;
  if (!present) {
    if (!state.widgets.includes(key)) return state;
    return { ...state, widgets: state.widgets.filter((widget) => widget !== key) };
  }
  if (state.widgets.includes(key)) return state;
  return { ...state, widgets: [...state.widgets, key] };
}

function applyDialog(state: SessionState, frame: Frame): SessionState {
  const method = asString(frame.method);
  if (method === 'setStatus') return applyStatus(state, frame);
  if (method === 'setWidget') return applyWidget(state, frame);
  if (method === 'set_editor_text') {
    if (typeof frame.text !== 'string') return state;
    return { ...state, editorTextRequest: { id: asString(frame.id), text: frame.text } };
  }
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return state;
  const options = Array.isArray(frame.options) ? frame.options.map((option) => asString(option)).filter(Boolean) : [];
  return {
    ...state,
    dialog: {
      id: asString(frame.id),
      method,
      title: asString(frame.title, 'The agent needs an answer'),
      message: asString(frame.message),
      options,
      placeholder: asString(frame.placeholder),
      prefill: asString(frame.prefill),
    },
  };
}

/** The thinking blocks of a journalled assistant message, joined as one passage. */
function thinkingFromContent(content: readonly Frame[]): string {
  return content
    .map((block) => (block.type === 'thinking' ? asString(block.thinking) : ''))
    .filter(Boolean)
    .join('');
}

/** Remembers a prompt this page rendered, so the journal's copy of it folds into the same entry. */
function withPendingUser(state: SessionState, id: string, text: string, images: UserImage[] = []): SessionState {
  const pending = { id, text, ...(images.length > 0 ? { images } : {}) };
  return { ...state, pendingUserEntries: [...state.pendingUserEntries, pending] };
}

/**
 * Folds a journalled user message into the entry this page already rendered
 * for it, or returns undefined when no such entry exists.
 *
 * A message the cockpit sent is on screen before it reaches the journal, and a
 * queued one is on screen as queued until the run picks it up. Both are the
 * same message the journal later reports, so it settles the entry that stands
 * rather than adding a second copy of the text.
 *
 * A prompt Pi's protocol snapshot already claimed is matched here too. That
 * claim consumed the pending record, so without the second list a journalled
 * copy arriving after the run, which is what happens when transcript
 * ownership falls back to the journal, would read as a new message and be
 * appended below the settled divider.
 */
function reconcilePendingUser(state: SessionState, text: string, images: UserImage[]): SessionState | undefined {
  const index = state.pendingUserEntries.findIndex((pending) => pending.text === text);
  const reconciledIndex = index === -1 ? state.reconciledUserEntries.findIndex((claimed) => claimed.text === text) : -1;
  if (index === -1 && reconciledIndex === -1) return undefined;
  const source = index === -1 ? state.reconciledUserEntries : state.pendingUserEntries;
  const at = index === -1 ? reconciledIndex : index;
  const pending = source[at] as { id: string; images?: UserImage[] };
  // A pending prompt is claimed once, because a second copy of the same text is
  // a second message. A claim already published is kept: the hub re-reads the
  // journal at every run boundary, and each of those copies has to fold into the
  // entry that stands rather than becoming a new one.
  const remaining = index === -1 ? state.reconciledUserEntries : source.filter((_, position) => position !== at);
  const entries = state.entries.map((entry) => {
    if (entry.id !== pending.id) return entry;
    const reconciledImages = images.length > 0 ? images : pending.images;
    if (entry.kind === 'queued') {
      return {
        kind: 'user' as const,
        id: entry.id,
        text: entry.text,
        ...(reconciledImages ? { images: reconciledImages } : {}),
      };
    }
    return entry.kind === 'user' && images.length > 0 ? { ...entry, images } : entry;
  });
  return index === -1
    ? { ...state, entries, reconciledUserEntries: remaining }
    : { ...state, entries, pendingUserEntries: remaining };
}

/**
 * Folds one journalled message into the timeline.
 *
 * The journal is the session's own record, so its shape is not the live frame
 * shape: a tool call is a block inside an assistant message (`id`,
 * `arguments`) rather than a tool_execution_start frame, and its result is a
 * message of its own. Mapping them here is what lets a transcript written
 * before this page existed read exactly like one it watched arrive.
 */
function applyJournalMessage(state: SessionState, message: Frame): SessionState {
  const role = asString(message.role);
  const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];

  if (role === 'user') {
    const text = textFromContent(content);
    const images = imagesFromContent(content);
    if (!text && images.length === 0) return state;
    return (
      reconcilePendingUser(state, text, images) ??
      withEntry(state, { kind: 'user', id: `u${state.nextId}`, text, ...(images.length > 0 ? { images } : {}) })
    );
  }

  if (role === 'assistant') {
    const text = textFromContent(content);
    const thinking = thinkingFromContent(content);
    let next =
      text || thinking
        ? withEntry(state, { kind: 'assistant', id: `a${state.nextId}`, text, thinking, streaming: false })
        : state;
    for (const block of content) {
      if (block.type !== 'toolCall') continue;
      // The result is a later entry, so the card starts as running and the
      // result that follows settles it, exactly as a live run does.
      next = withEntry(next, {
        kind: 'tool',
        id: `t${next.nextId}`,
        toolCallId: asString(block.id),
        name: asString(block.name, 'tool'),
        args: isRecord(block.arguments) ? block.arguments : {},
        argSummary: summariseArgs(block.arguments),
        result: null,
        output: '',
        isError: false,
        running: true,
      });
    }
    return next;
  }

  if (role === 'toolResult') {
    return updateTool(state, asString(message.toolCallId), {
      result: { content, details: message.details },
      output: textFromContent(content),
      isError: message.isError === true,
      running: false,
    });
  }

  return state;
}

/**
 * Folds one journal entry, once. Entries without an id are the runtime's own
 * bookkeeping and are left alone; a message already folded is skipped, which
 * is what makes a re-attach idempotent.
 */
function applyJournalEntry(state: SessionState, entry: Frame): SessionState {
  if (entry.type !== 'message' || !isRecord(entry.message)) return state;
  const id = asString(entry.id);
  if (id === '' || state.restoredIds.includes(id)) return state;
  const next = applyJournalMessage(state, entry.message);
  return { ...next, restoredIds: [...next.restoredIds, id] };
}

/**
 * Records a journal entry the protocol already publishes, without folding it.
 *
 * The hub re-reads the journal at every run boundary and re-publishes user
 * messages, because no live frame carries one. Dropping those copies without a
 * trace left the page with no memory of them, so a copy arriving after protocol
 * ownership lapsed read as a new prompt and landed below the settled divider.
 * Keeping the id is what makes the drop idempotent.
 */
function rememberJournalEntry(state: SessionState, entry: Frame): SessionState {
  if (entry.type !== 'message' || !isRecord(entry.message)) return state;
  const id = asString(entry.id);
  if (id === '' || state.restoredIds.includes(id)) return state;
  return { ...state, restoredIds: [...state.restoredIds, id] };
}

/**
 * Folds an older window of transcript above what the page already holds.
 *
 * The reducer is append-only by design: it builds the timeline as the session
 * produces it. Paging backwards is the one case that runs the other way, so
 * the window is reduced on its own and the result is prepended, rather than
 * teaching every case in the reducer about a second direction.
 *
 * Entry ids are positional, so a window reduced from scratch would collide
 * with the live entries. Prefixing by page keeps every key unique and stable
 * across re-renders, which is what a virtualised list needs to keep its
 * measurements.
 */
export function prependHistory(state: SessionState, frames: readonly Frame[], page: number): SessionState {
  // Wrapped: reduce would otherwise pass the index as the options argument.
  const older = frames.reduce((carried, frame) => reduceSession(carried, frame), initialSessionState);
  const known = new Set(state.restoredIds);
  const restored = older.restoredIds.filter((id) => !known.has(id));
  if (restored.length === 0) return state;
  const prefix = `h${page}-`;
  const entries = older.entries
    .filter((entry) => entry.kind !== 'notice')
    .map((entry) => ({ ...entry, id: `${prefix}${entry.id}` }) as TimelineEntry);
  return {
    ...state,
    entries: [...entries, ...state.entries],
    restoredIds: [...restored, ...state.restoredIds],
  };
}

/**
 * Folds one agent frame into the view model.
 *
 * Pure and total: an unrecognised frame returns the state unchanged, so a Pi
 * protocol addition cannot break the cockpit, it just is not rendered yet.
 */
/** Frames whose only product is a timeline entry the protocol now publishes. */
const TRANSCRIPT_FRAMES = new Set([
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
]);

export interface ReduceSessionOptions {
  /**
   * The protocol supplies the transcript, so this reducer must not build one.
   *
   * Both would otherwise write the same timeline from different sources: the
   * snapshot replaces it wholesale while these frames append to it, and the
   * result flickers between the two. The frames still reach here for
   * everything else they carry, which is why this is a filter rather than a
   * missing subscription.
   */
  transcriptFromProtocol?: boolean;
}

export function reduceSession(state: SessionState, frame: Frame, options: ReduceSessionOptions = {}): SessionState {
  const type = asString(frame.type);
  if (options.transcriptFromProtocol && TRANSCRIPT_FRAMES.has(type)) {
    if (type === 'tool_execution_start') {
      const active = toolEntryFromStart(frame, `active:${asString(frame.toolCallId)}`);
      const activeTools = [...state.activeTools.filter((entry) => entry.toolCallId !== active.toolCallId), active];
      return { ...state, activeTools, toolsThisRun: state.toolsThisRun + 1 };
    }
    if (type === 'tool_execution_end') {
      const toolCallId = asString(frame.toolCallId);
      return { ...state, activeTools: state.activeTools.filter((entry) => entry.toolCallId !== toolCallId) };
    }
    return state;
  }

  switch (type) {
    case 'replay':
      return isRecord(frame.frame) ? reduceSession(state, frame.frame, options) : state;

    case 'agent_start':
      return { ...state, activeTools: [], streaming: true, settled: false, toolsThisRun: 0 };

    case 'message_update':
      return isRecord(frame.assistantMessageEvent) ? applyAssistantDelta(state, frame.assistantMessageEvent) : state;

    case 'message_end':
      return closeAssistant(state, frame.message);

    case 'tool_execution_start':
      return applyToolStart(state, frame);

    case 'tool_execution_update':
      return updateTool(state, asString(frame.toolCallId), {
        result: toolResult(frame.partialResult),
        output: textFromContent(isRecord(frame.partialResult) ? frame.partialResult.content : undefined),
      });

    case 'tool_execution_end':
      return updateTool(state, asString(frame.toolCallId), {
        result: toolResult(frame.result),
        output: textFromContent(isRecord(frame.result) ? frame.result.content : undefined),
        isError: frame.isError === true,
        running: false,
      });

    case 'agent_settled': {
      const closed = options.transcriptFromProtocol ? state : closeAssistant(state, undefined);
      const marked = withEntry(closed, { kind: 'settled', id: `s${closed.nextId}`, tools: closed.toolsThisRun });
      return { ...marked, activeTools: [], dialog: null, streaming: false, settled: true };
    }

    case 'queue_update': {
      const steering = Array.isArray(frame.steering) ? frame.steering : [];
      const followUp = Array.isArray(frame.followUp) ? frame.followUp : [];
      const queue = [
        ...steering.map((entry) => ({ text: asString(entry), delivery: 'steer' as const })),
        ...followUp.map((entry) => ({ text: asString(entry), delivery: 'followUp' as const })),
      ]
        .map((entry, index) => ({ kind: 'queued' as const, id: `queue-${index}`, ...entry }))
        .filter((entry) => entry.text.length > 0);
      return replaceQueuedEntries(state, queue);
    }

    case 'extension_ui_request': {
      // Agent notifications carry the outcome a TUI user would see (a mode
      // switch pending a relaunch, a refused action); dropping them reads as
      // the agent doing nothing.
      if (frame.method === 'notify') {
        const text = asString(frame.message, '');
        if (text === '') return state;
        return withEntry(state, {
          kind: 'notice',
          id: `n${state.nextId}`,
          text,
          tone: frame.notifyType === 'error' ? 'error' : 'info',
        });
      }
      return applyDialog(state, frame);
    }

    // Hub-synthesized when any tab answers a dialog: closes it on other live
    // tabs, and on backlog replays keeps an answered request from reopening.
    case DIALOG_ANSWERED_TYPE:
      return state.dialog && state.dialog.id === asString(frame.id) ? { ...state, dialog: null } : state;

    // The runtime journals its minor-mode catalog as a custom entry; every
    // other custom entry belongs to some extension's own bookkeeping.
    case 'entry_appended': {
      const entry = isRecord(frame.entry) ? frame.entry : undefined;
      if (!entry) return state;
      if (entry.type === 'custom' && entry.customType === MINOR_MODE_ENTRY_TYPE) {
        const data = isRecord(entry.data) ? entry.data : undefined;
        if (!data || !Array.isArray(data.modes)) return state;
        return { ...state, minorModes: data as unknown as MinorModeProjection };
      }
      if (entry.type === 'custom' && entry.customType === CONTEXT_ENTRY_TYPE) {
        const data = isRecord(entry.data) ? entry.data : undefined;
        if (!data || !Array.isArray(data.groups)) return state;
        return { ...state, context: data as unknown as ContextProjection };
      }
      // A journalled user message is a transcript entry the protocol already
      // publishes; the catalog above is DoomPi's own and always applies.
      return options.transcriptFromProtocol ? rememberJournalEntry(state, entry) : applyJournalEntry(state, entry);
    }

    case 'response':
      return applyResponse(state, frame);

    case 'error':
    case 'extension_error':
      return withEntry(state, {
        kind: 'notice',
        id: `n${state.nextId}`,
        text: asString(frame.message ?? frame.error, 'The agent reported an error.'),
        tone: 'error',
      });

    default:
      return state;
  }
}

/** Records the prompt locally, because Pi does not echo it back as an event. */
export function appendUserPrompt(state: SessionState, text: string, images: UserImage[] = []): SessionState {
  const id = `u${state.nextId}`;
  const entry: UserEntry = { kind: 'user', id, text, ...(images.length > 0 ? { images } : {}) };
  return withPendingUser(withEntry(state, entry), id, text, images);
}

/** A follow-up waits for the current run, so it is marked rather than shown as sent. */
export function appendQueued(state: SessionState, text: string, images: UserImage[] = []): SessionState {
  const id = `q${state.nextId}`;
  const entry: QueuedEntry = {
    kind: 'queued',
    id,
    text,
    delivery: 'followUp',
    ...(images.length > 0 ? { images } : {}),
  };
  return withPendingUser(withEntry(state, entry), id, text, images);
}

/** Replaces visible queued rows while preserving optimistic ids and attachments. */
export function replaceQueuedEntries(state: SessionState, queue: readonly QueuedEntry[]): SessionState {
  const remaining = state.entries.filter((entry): entry is QueuedEntry => entry.kind === 'queued');
  const normalized = queue.map((entry) => {
    const existingIndex = remaining.findIndex((candidate) => candidate.text === entry.text);
    if (existingIndex === -1) return entry;
    const [existing] = remaining.splice(existingIndex, 1);
    return existing === undefined
      ? entry
      : {
          ...entry,
          id: existing.id,
          ...(entry.delivery === undefined && existing.delivery !== undefined ? { delivery: existing.delivery } : {}),
          ...(existing.images ? { images: existing.images } : {}),
        };
  });
  const pendingUserEntries = [...state.pendingUserEntries];
  for (const entry of normalized) {
    if (!pendingUserEntries.some((pending) => pending.id === entry.id)) {
      pendingUserEntries.push({ id: entry.id, text: entry.text, ...(entry.images ? { images: entry.images } : {}) });
    }
  }
  return {
    ...state,
    entries: [...state.entries.filter((entry) => entry.kind !== 'queued'), ...normalized],
    pendingUserEntries,
  };
}

/** Removes queued rows and their reconciliation records after Pi clears the queue. */
export function clearQueuedEntries(state: SessionState): SessionState {
  const queuedIds = new Set(state.entries.filter((entry) => entry.kind === 'queued').map((entry) => entry.id));
  return {
    ...state,
    entries: state.entries.filter((entry) => entry.kind !== 'queued'),
    pendingUserEntries: state.pendingUserEntries.filter((entry) => !queuedIds.has(entry.id)),
  };
}

/** Removes one queued row and the optimistic reconciliation record tied to it. */
export function removeQueuedEntry(state: SessionState, id: string): SessionState {
  return {
    ...state,
    entries: state.entries.filter((entry) => entry.kind !== 'queued' || entry.id !== id),
    pendingUserEntries: state.pendingUserEntries.filter((entry) => entry.id !== id),
  };
}
export function clearDialog(state: SessionState): SessionState {
  return { ...state, dialog: null };
}
