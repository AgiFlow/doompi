export type EntryKind = 'user' | 'assistant' | 'tool' | 'notice';

export interface UserEntry {
  kind: 'user';
  id: string;
  text: string;
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
  argSummary: string;
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

export interface SessionState {
  entries: TimelineEntry[];
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
  dialog: DialogRequest | null;
  /** Tool calls seen since the current run began, reported when it settles. */
  toolsThisRun: number;
  nextId: number;
}

export const initialSessionState: SessionState = {
  entries: [],
  statuses: {},
  widgets: [],
  streaming: false,
  settled: false,
  stats: null,
  agent: null,
  commands: [],
  dialog: null,
  toolsThisRun: 0,
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

function applyToolStart(state: SessionState, frame: Frame): SessionState {
  const entry: ToolEntry = {
    kind: 'tool',
    id: `t${state.nextId}`,
    toolCallId: asString(frame.toolCallId),
    name: asString(frame.toolName, 'tool'),
    argSummary: summariseArgs(frame.args),
    output: '',
    isError: false,
    running: true,
  };
  const opened = withEntry(closeAssistant(state, undefined), entry);
  return { ...opened, toolsThisRun: opened.toolsThisRun + 1 };
}

function updateTool(state: SessionState, toolCallId: string, patch: Partial<ToolEntry>): SessionState {
  const index = state.entries.findLastIndex((entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId);
  if (index === -1) return state;
  const entries = [...state.entries];
  entries[index] = { ...(entries[index] as ToolEntry), ...patch };
  return { ...state, entries };
}

function applyResponse(state: SessionState, frame: Frame): SessionState {
  const command = asString(frame.command);
  const data = frame.data;
  if (!isRecord(data)) return state;

  if (command === 'get_state') {
    const model = isRecord(data.model) ? asString(data.model.id ?? data.model.name, 'unknown') : 'unknown';
    return {
      ...state,
      agent: {
        model,
        thinkingLevel: asString(data.thinkingLevel, 'unknown'),
        sessionId: asString(data.sessionId),
        sessionName: asString(data.sessionName),
        messageCount: asNumber(data.messageCount) ?? 0,
        isStreaming: data.isStreaming === true,
      },
    };
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
    const commands = raw
      .filter(isRecord)
      .map((entry) => ({ name: asString(entry.name), description: asString(entry.description) }))
      .filter((entry) => entry.name.length > 0);
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
  if (!key || state.widgets.includes(key)) return state;
  return { ...state, widgets: [...state.widgets, key] };
}

function applyDialog(state: SessionState, frame: Frame): SessionState {
  const method = asString(frame.method);
  if (method === 'setStatus') return applyStatus(state, frame);
  if (method === 'setWidget') return applyWidget(state, frame);
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

/**
 * Folds one agent frame into the view model.
 *
 * Pure and total: an unrecognised frame returns the state unchanged, so a Pi
 * protocol addition cannot break the cockpit, it just is not rendered yet.
 */
export function reduceSession(state: SessionState, frame: Frame): SessionState {
  const type = asString(frame.type);

  switch (type) {
    case 'replay':
      return isRecord(frame.frame) ? reduceSession(state, frame.frame) : state;

    case 'agent_start':
      return { ...state, streaming: true, settled: false, toolsThisRun: 0 };

    case 'message_update':
      return isRecord(frame.assistantMessageEvent) ? applyAssistantDelta(state, frame.assistantMessageEvent) : state;

    case 'message_end':
      return closeAssistant(state, frame.message);

    case 'tool_execution_start':
      return applyToolStart(state, frame);

    case 'tool_execution_update':
      return updateTool(state, asString(frame.toolCallId), {
        output: textFromContent(isRecord(frame.partialResult) ? frame.partialResult.content : undefined),
      });

    case 'tool_execution_end':
      return updateTool(state, asString(frame.toolCallId), {
        output: textFromContent(isRecord(frame.result) ? frame.result.content : undefined),
        isError: frame.isError === true,
        running: false,
      });

    case 'agent_settled': {
      const closed = closeAssistant(state, undefined);
      const marked = withEntry(closed, { kind: 'settled', id: `s${closed.nextId}`, tools: closed.toolsThisRun });
      return { ...marked, streaming: false, settled: true };
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
export function appendUserPrompt(state: SessionState, text: string): SessionState {
  return withEntry(state, { kind: 'user', id: `u${state.nextId}`, text });
}

/** A follow-up waits for the current run, so it is marked rather than shown as sent. */
export function appendQueued(state: SessionState, text: string): SessionState {
  return withEntry(state, { kind: 'queued', id: `q${state.nextId}`, text });
}

export function clearDialog(state: SessionState): SessionState {
  return { ...state, dialog: null };
}
