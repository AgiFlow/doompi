import type { BridgeState, SessionFrame } from './session.ts';

/**
 * Wire vocabulary between the hub and its pages.
 *
 * One WebSocket carries every session: hub-level frames describe the set of
 * sessions, and session-scoped traffic travels enveloped with the session id.
 * Field naming follows @earendil-works/pi-protocol so a future swap to the
 * upstream session server stays a transport change, not a rename.
 */
export const HUB_PROTOCOL_VERSION = 1;

/** Role marker in the health payload; doompi-server probes for it before binding the port. */
export const HUB_ROLE = 'hub';

/** REST endpoint for creating sessions; the page posts {cwd, name?} and receives {sessionId}. */
export const SESSIONS_API_ROUTE = '/api/sessions';

/**
 * REST endpoint behind the new-session directory picker; the page sends the
 * typed path as ?q= and receives {directories}: the children of the parent
 * directory whose names match the trailing segment as a regular expression.
 */
export const DIRECTORIES_API_ROUTE = '/api/directories';

/**
 * Query parameter that routes a package API request to one session's server.
 * Without it the request is answered by a hub-scoped API in this process.
 */
export const API_SESSION_QUERY_PARAM = 'session';

/** What the agent is doing right now, derived from its frame stream. */
export type SessionPhase = 'idle' | 'turn' | 'compaction' | 'retry';

export interface SessionGitStatus {
  branch: string;
  /** True when the working tree has uncommitted changes; rendered as a star. */
  dirty: boolean;
}

/**
 * Everything the rail needs to render one session without subscribing to it.
 */
export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  /** ISO 8601, from the session's registry record. */
  createdAt: string;
  /** ISO 8601, bumped whenever the session's frame stream moves. */
  updatedAt: string;
  phase: SessionPhase;
  /** ISO 8601 timestamp of the last phase change; drives "running · 12m". */
  phaseSince: string;
  /** The hub's own attachment to the session socket. */
  attach: BridgeState;
  /** Human-readable cause, present when attach is refused or closed. */
  attachReason?: string;
  pendingMessageCount: number;
  /** False until the first prompt is forwarded; "fresh session · nothing sent yet". */
  everPrompted: boolean;
  /** True while the agent waits on a dialog answer; "waiting for your input". */
  awaitingInput: boolean;
  /** ISO 8601 of the last settled run, once one finished. */
  lastSettledAt?: string;
  /** Shown in the refused overlay so the user can find the competing client. */
  socketPath: string;
  /** Where this session serves its package APIs, when it serves any; the hub proxies there. */
  apiSocketPath?: string;
  /** Omitted when the cwd is not a git repository or git is unavailable. */
  git?: SessionGitStatus;
}

/**
 * Per-plugin session data travels as ChannelFrame: the channel name is the
 * frame type and the payload shape belongs to the plugin. Re-exported so in-package code keeps importing wire shapes
 * from this one root.
 */
export type { ChannelFrame } from '@agimon-ai/doompi-web-contracts';

export const HUB_HELLO_TYPE = 'hub_hello';
export const SESSIONS_SNAPSHOT_TYPE = 'sessions_snapshot';
export const SESSION_UPSERT_TYPE = 'session_upsert';
export const SESSION_REMOVED_TYPE = 'session_removed';
export const SESSION_BACKLOG_TYPE = 'session_backlog';
export const SESSION_FRAME_TYPE = 'session_frame';
/** Hub-synthesized close for an answered dialog; Pi itself never announces one. */
export const DIALOG_ANSWERED_TYPE = 'extension_ui_answered';
/**
 * Sync rebuilt the artifacts this page is running against.
 *
 * The plugin bundle the browser loaded is one of them, and a bundle only
 * changes on disk: nothing about the running page notices. The page reloads
 * itself rather than staying on surfaces the repository no longer describes.
 */
export const HUB_RESYNCED_TYPE = 'hub_resynced';

/**
 * The custom session entry the DoomPi runtime journals with its minor-mode
 * catalog projection; it arrives inside Pi's entry_appended frames. The shape
 * mirrors MinorModeProjection in doompi-extension-contracts.
 */
export const MINOR_MODE_ENTRY_TYPE = 'doom-minor-modes';

export interface MinorModeActionProjection {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  disabledReason?: string;
  needsInput: boolean;
}

export interface MinorModeRecordProjection {
  id: string;
  label: string;
  description: string;
  order: number;
  activation: 'inactive' | 'activating' | 'active' | 'deactivating';
  condition: string;
  detail?: string;
  actions: MinorModeActionProjection[];
}

export interface MinorModeProjection {
  version: 1;
  revision: number;
  modes: MinorModeRecordProjection[];
}
export const SUBSCRIBE_TYPE = 'subscribe';
export const UNSUBSCRIBE_TYPE = 'unsubscribe';
export const SESSION_COMMAND_TYPE = 'session_command';
/** A page follows one thread of a session: a journal a plugin's hub source names, such as a subagent run. */
export const SUBSCRIBE_THREAD_TYPE = 'subscribe_thread';
export const UNSUBSCRIBE_THREAD_TYPE = 'unsubscribe_thread';
export const THREAD_BACKLOG_TYPE = 'thread_backlog';
export const THREAD_FRAME_TYPE = 'thread_frame';

/** A page asks for the transcript before what it already holds. */
export const HISTORY_REQUEST_TYPE = 'history_request';
/** One older window, oldest first, answering a history_request. */
export const HISTORY_PAGE_TYPE = 'history_page';

/**
 * How many journalled messages one page carries. Small enough that prepending
 * a window never blocks the reader's scroll, large enough that a flick through
 * a long transcript does not turn into a hundred round trips.
 */
export const HISTORY_PAGE_SIZE = 100;

export interface HistoryRequestFrame {
  type: typeof HISTORY_REQUEST_TYPE;
  sessionId: string;
  /** Journal id of the oldest entry the page holds; absent asks for the newest window. */
  before?: string;
  limit?: number;
}

export interface HistoryPageFrame {
  type: typeof HISTORY_PAGE_TYPE;
  sessionId: string;
  /** Entry frames, oldest first, to prepend above what the page holds. */
  frames: Record<string, unknown>[];
  /** The cursor for the next older window; null when the transcript starts here. */
  cursor: string | null;
  /** Whether anything older than this window exists. */
  hasMore: boolean;
  /** Echoed so a page can drop an answer to a question it has since abandoned. */
  before?: string;
}

/** First frame on every page socket, before the snapshot. */
export interface HubHelloFrame {
  type: typeof HUB_HELLO_TYPE;
  protocol: number;
  /** Frame types of the hub's loaded data channels; lets a panel tell "plugin server not installed" from "no data". */
  channels: string[];
}

export interface SessionsSnapshotFrame {
  type: typeof SESSIONS_SNAPSHOT_TYPE;
  sessions: SessionSummary[];
}

export interface SessionUpsertFrame {
  type: typeof SESSION_UPSERT_TYPE;
  session: SessionSummary;
}

export interface SessionRemovedFrame {
  type: typeof SESSION_REMOVED_TYPE;
  sessionId: string;
}

/** Reply to subscribe: recent history from the hub's ring, then live frames follow. */
export interface SessionBacklogFrame {
  type: typeof SESSION_BACKLOG_TYPE;
  sessionId: string;
  frames: SessionFrame[];
  /** Frames the bounded ring had to discard before this page subscribed. */
  dropped: number;
}

/** One live agent frame, addressed to subscribers of its session. */
export interface SessionFrameEnvelope {
  type: typeof SESSION_FRAME_TYPE;
  sessionId: string;
  frame: SessionFrame;
}

export interface SubscribeFrame {
  type: typeof SUBSCRIBE_TYPE;
  sessionId: string;
}

export interface UnsubscribeFrame {
  type: typeof UNSUBSCRIBE_TYPE;
  sessionId: string;
}

/** One command frame from the page, addressed to a session's agent. */
export interface SessionCommandFrame {
  type: typeof SESSION_COMMAND_TYPE;
  sessionId: string;
  frame: SessionFrame;
}

export function hubHello(channels: string[]): HubHelloFrame {
  return { type: HUB_HELLO_TYPE, protocol: HUB_PROTOCOL_VERSION, channels };
}

export function sessionFrameEnvelope(sessionId: string, frame: SessionFrame): SessionFrameEnvelope {
  return { type: SESSION_FRAME_TYPE, sessionId, frame };
}

export function sessionCommand(sessionId: string, frame: SessionFrame): SessionCommandFrame {
  return { type: SESSION_COMMAND_TYPE, sessionId, frame };
}

export function subscribeFrame(sessionId: string): SubscribeFrame {
  return { type: SUBSCRIBE_TYPE, sessionId };
}

export function unsubscribeFrame(sessionId: string): UnsubscribeFrame {
  return { type: UNSUBSCRIBE_TYPE, sessionId };
}

export interface SubscribeThreadFrame {
  type: typeof SUBSCRIBE_THREAD_TYPE;
  sessionId: string;
  threadId: string;
}

export interface UnsubscribeThreadFrame {
  type: typeof UNSUBSCRIBE_THREAD_TYPE;
  sessionId: string;
  threadId: string;
}

/** Reply to subscribe_thread: the journal's newest entries as entry_appended frames, then live ones follow. */
export interface ThreadBacklogFrame {
  type: typeof THREAD_BACKLOG_TYPE;
  sessionId: string;
  threadId: string;
  frames: SessionFrame[];
}

/** One journal entry a followed thread gained, addressed to the pages following it. */
export interface ThreadFrameEnvelope {
  type: typeof THREAD_FRAME_TYPE;
  sessionId: string;
  threadId: string;
  frame: SessionFrame;
}

export function subscribeThreadFrame(sessionId: string, threadId: string): SubscribeThreadFrame {
  return { type: SUBSCRIBE_THREAD_TYPE, sessionId, threadId };
}

export function unsubscribeThreadFrame(sessionId: string, threadId: string): UnsubscribeThreadFrame {
  return { type: UNSUBSCRIBE_THREAD_TYPE, sessionId, threadId };
}

export function threadBacklog(sessionId: string, threadId: string, frames: SessionFrame[]): ThreadBacklogFrame {
  return { type: THREAD_BACKLOG_TYPE, sessionId, threadId, frames };
}

export function threadFrameEnvelope(sessionId: string, threadId: string, frame: SessionFrame): ThreadFrameEnvelope {
  return { type: THREAD_FRAME_TYPE, sessionId, threadId, frame };
}
