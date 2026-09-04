import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelFrame,
  ComputerUseHostBinding,
  HubChannelHost,
  HubChannelSource,
  HubSessionApiRequest,
  HubSessionScope,
  WebHubChannel,
} from '@agimon-ai/doompi-web-contracts';
import type { DoomTelemetry, DoomTraceContext } from '@agimon-ai/doompi-telemetry';
import { createFrameRing, type FrameRing } from '../services/frameRing.ts';
import {
  initialPresence,
  presenceAfterCommand,
  presenceAfterRestoredEntry,
  reducePresence,
  type SessionPresence,
} from '../services/sessionPresence.ts';
import type { SessionAttachment } from '../types/bridge.ts';
import {
  DIALOG_ANSWERED_TYPE,
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_TYPE,
  type HistoryPageFrame,
  CONTEXT_ENTRY_TYPE,
  MINOR_MODE_ENTRY_TYPE,
  SESSION_BACKLOG_TYPE,
  type SessionBacklogFrame,
  type SessionGitStatus,
  type SessionSummary,
  type SessionWebComposition,
} from '../types/hub.ts';
import type { SessionRecord } from '../types/registry.ts';
import { REPLAY_TYPE, type BridgeState, type SessionFrame } from '../types/session.ts';
import type { RecordSource } from './registryWatcher.ts';
import type { SessionSpawner, SpawnOutcome, SpawnSessionInput } from './serverSpawner.ts';
import { attachToSession } from './sessionSocketClient.ts';
import { proxyToSocket } from './packageApiProxy.ts';
import { carriesUserImages, shrinkUserImages, userImageLimits } from './promptImages.ts';

const GIT_REFRESH_MS = 10_000;
const GET_ENTRIES_COMMAND = 'get_entries';
/**
 * How much of a long transcript a fresh attach restores. The ring holds 512
 * frames and live ones have to fit beside the history, so a session with
 * thousands of messages gives up its oldest rather than its newest.
 */
const DEFAULT_RESTORE_LIMIT = 300;
/**
 * Journalled messages retained per session for paging back through. Well past
 * any transcript a reader scrolls by hand, and still bounded: a hub watching a
 * dozen long sessions holds a list, not a session's whole life.
 */
const DEFAULT_JOURNAL_LIMIT = 5000;
const ENTRY_APPENDED_TYPE = 'entry_appended';
/**
 * How long a restart waits for the stopped server to withdraw its record. A
 * session flushes its transcript on the way out, so the wait is generous; past
 * it the restart reports rather than starting a second server on the same
 * socket.
 */
const DEFAULT_RESTART_WAIT_MS = 15_000;
const DEFAULT_RESTART_POLL_MS = 100;

/**
 * One session-local projection, including a replay wrapper from its server.
 *
 * A projection is the current answer to a standing question, not an event, so
 * only the newest copy matters and it has to survive for as long as the session
 * does. Status lines and widgets are the obvious ones. The composition entries
 * belong here for the same reason and a sharper one: the runtime journals them
 * only when the composition actually changes, which on a long session is once,
 * hours before the reader opens the page. Left in the bounded ring they are
 * evicted by ordinary traffic, and the context panel then shows the modes the
 * status line still carries with none of the tools underneath them.
 */
function uiProjectionKey(frame: SessionFrame): string | undefined {
  const replayed = frame.frame;
  const projected =
    frame.type === REPLAY_TYPE && typeof replayed === 'object' && replayed !== null && !Array.isArray(replayed)
      ? (replayed as SessionFrame)
      : frame;
  if (projected.type === ENTRY_APPENDED_TYPE) return compositionEntryKey(projected.entry);
  if (projected.type !== 'extension_ui_request') return undefined;
  if (projected.method === 'setStatus' && typeof projected.statusKey === 'string') {
    return `status:${projected.statusKey}`;
  }
  if (projected.method === 'setWidget' && typeof projected.widgetKey === 'string') {
    return `widget:${projected.widgetKey}`;
  }
  return undefined;
}

/** The projection key for a custom composition entry, or undefined for any other entry. */
function compositionEntryKey(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const candidate = entry as Record<string, unknown>;
  if (candidate.type !== 'custom') return undefined;
  if (candidate.customType !== MINOR_MODE_ENTRY_TYPE && candidate.customType !== CONTEXT_ENTRY_TYPE) return undefined;
  return `entry:${String(candidate.customType)}`;
}

export type HubEvent =
  | { kind: 'upsert'; session: SessionSummary }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'frame'; sessionId: string; frame: SessionFrame }
  | { kind: 'channel'; frameType: string; sessionId: string; payload: unknown; connectionId?: string };

export interface SessionHubOptions {
  source: RecordSource;
  /** Absent only in tests; without one, creating sessions is refused. */
  spawner?: SessionSpawner;
  /** Injectable for tests; defaults to asking git about the session cwd. */
  readGit?: (cwd: string) => Promise<SessionGitStatus | undefined>;
  /** Base channels installed into every session-local channel registry. */
  channels?: readonly WebHubChannel[];
  /** Dynamically loads the channel composition resolved for one session. */
  loadChannels?: (record: SessionRecord) => Promise<readonly WebHubChannel[]>;
  /** Advertises the signed client composition paired with one session's loaded channels. */
  webComposition?: (record: SessionRecord, channelTypes: readonly string[]) => SessionWebComposition | undefined;
  /** Present only when this hub is the authenticated child of DoomPi Desktop. */
  computerUse?: ComputerUseHostBinding;
  /** Injectable for tests; defaults to SIGTERM, which doompi-server treats as a clean stop. */
  signal?: (pid: number) => void;
  /** How long a restart waits for the stopped server to withdraw its record. */
  restartWaitMs?: number;
  restartPollMs?: number;
  ringLimit?: number;
  /** Journalled messages restored per session on attach; the rest is kept for paging back through. */
  restoreLimit?: number;
  /** Journalled messages retained per session for paging; the oldest are forgotten first. */
  journalLimit?: number;
  gitRefreshMs?: number;
  onNotice?: (message: string) => void;
  telemetry?: DoomTelemetry;
}

export type StopOutcome = { ok: true } | { ok: false; code: 'unknown' | 'self' | 'signal_failed'; error: string };
export type PlanSaveState = 'allowed' | 'locked' | 'unavailable';

export interface SessionHub {
  snapshot(): SessionSummary[];
  /** The registry records behind the live sessions, for clients that dial them directly. */
  records(): SessionRecord[];
  /** Whether the latest authoritative minor-mode projection permits a host file save. */
  planSaveState(sessionId: string): PlanSaveState;
  /** Asks a session's server to exit; the session leaves once its record is withdrawn. */
  stop(sessionId: string): StopOutcome;
  /** Streams every change; pages filter frame events by their subscriptions. */
  onEvent(listener: (event: HubEvent) => void): () => void;
  /** Current UI projections and recent transient history for one session, or undefined for an unknown id. */
  backlog(sessionId: string): SessionBacklogFrame | undefined;
  /** One older window of a session's transcript, for a page scrolling back. */
  history(sessionId: string, request: { before?: string; limit?: number }): HistoryPageFrame | undefined;
  /** Frame types of the loaded data channels, for the hello frame. */
  channelTypes(): string[];
  /** Every channel's subscribe-time snapshot for one session; empty for an unknown id. */
  channelFrames(sessionId: string): ChannelFrame[];
  /** The journal behind one thread of a session, from the first data channel that names it; undefined until one does. */
  threadJournal(sessionId: string, threadId: string): string | undefined;
  /** Whether one session's channel accepts authenticated acknowledgements after subscription changes. */
  channelReceivesWithoutSubscription(sessionId: string, frameType: string): boolean;
  /** Routes a page payload to exactly one loaded channel for a live session. */
  receiveChannel(sessionId: string, frameType: string, payload: unknown, connectionId: string): void;
  /** Withdraws connection-scoped channel state when a page socket closes. */
  disconnectChannels(connectionId: string): void;
  /** Reloads one session's channels after its synchronized generation changes. */
  reloadChannels(sessionId: string): void;
  command(sessionId: string, frame: SessionFrame): void;
  create(input: SpawnSessionInput): Promise<SpawnOutcome>;
  /**
   * Stops a session's server and brings it back under the same id.
   *
   * A running server reads the composition once: its extensions when the agent
   * starts, and its package API routes when the process does. So a rebuild
   * reaches an existing session only by replacing the process, which is what
   * this does, keeping the id so Pi resumes the same session and the transcript
   * survives.
   */
  restart(sessionId: string, trace?: DoomTraceContext): Promise<SpawnOutcome>;
  /** Replaces one live session with an inactive Pi thread from the same workspace. */
  resume(
    sessionId: string,
    target: { sessionId: string; name: string },
    trace?: DoomTraceContext,
  ): Promise<SpawnOutcome>;
  close(): void;
}

interface ManagedSession {
  record: SessionRecord;
  attachment?: SessionAttachment;
  ring: FrameRing;
  /** Latest status and widget frames for rebuilding only this session's browser store. */
  uiProjections: Map<string, SessionFrame>;
  presence: SessionPresence;
  attach: BridgeState;
  attachReason?: string;
  git?: SessionGitStatus;
  lastSummaryJson?: string;
  /**
   * Journal entry ids this hub has already published. Pi reports a message
   * entry only when the journal is read, never as it is written, so the hub
   * re-reads on each run boundary; remembering what it sent is what keeps that
   * re-read from replaying the whole transcript every time.
   */
  emittedEntryIds: Set<string>;
  /** Whether the first journal read has been published; later reads are refreshes. */
  restoredJournal: boolean;
  /**
   * Every journalled message the session has reported, oldest first.
   *
   * The attach path publishes only the newest slice, so without this the rest
   * of a long transcript would exist only on disk and a reader scrolling up
   * would find nothing. Bounded, because a hub watching many long sessions
   * should not grow without limit; the oldest go first, which is also the
   * order a reader runs out of interest in them.
   */
  journal: Record<string, unknown>[];
  frameCount: number;
  /**
   * The tail of this session's outbound command chain, so a resize in flight
   * cannot let a later command overtake an earlier one.
   */
  commands: Promise<void>;
  /** Channel definitions and sources loaded for this session's composition. */
  channels: StartedChannel[];
  channelLoadToken: symbol;
}

interface StartedChannel {
  channel: WebHubChannel;
  frameType: string;
  source: HubChannelSource;
  lifecycle: 'session' | 'hub';
}

/**
 * The journal entries a cockpit can render, oldest first.
 *
 * A session outlives every hub that watches it: it may have been driven from
 * the TUI for an hour before a cockpit existed, and a hub restart forgets the
 * live ring entirely. Without this the timeline of a long-running session
 * opens empty, which reads as "the agent has done nothing" rather than "this
 * page arrived late". The journal is the session's own record, so replaying it
 * is the only honest way to show what came before.
 *
 * Two kinds survive the filter: the messages that are the transcript, and the
 * newest minor-mode catalog entry, which the runtime journals as a custom
 * entry and which a late hub would otherwise never see.
 */
function renderableJournalEntries(frame: SessionFrame, limit: number): Record<string, unknown>[] {
  const data = frame.data;
  if (typeof data !== 'object' || data === null) return [];
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  const messages: Record<string, unknown>[] = [];
  // Both are projections rather than events, so only the last one matters and
  // replaying every copy would grow the backlog for no added meaning.
  const projections = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === 'message') messages.push(candidate);
    else if (
      candidate.type === 'custom' &&
      (candidate.customType === MINOR_MODE_ENTRY_TYPE || candidate.customType === CONTEXT_ENTRY_TYPE)
    ) {
      projections.set(String(candidate.customType), candidate);
    }
  }

  // The ring is bounded and live frames must still fit, so only the tail of a
  // long transcript is published on attach; the rest is retained for the page
  // to page back through rather than dropped on the floor.
  const kept = messages.length > limit ? messages.slice(-limit) : messages;
  return projections.size === 0 ? kept : [...kept, ...projections.values()];
}

/**
 * Every message a journal read carries, oldest first, with no tail limit.
 *
 * This is what the page pages back through. The attach path publishes only the
 * newest slice, because the ring is bounded and the live stream has to fit
 * beside it, but a reader scrolling up wants what came before, and the session
 * already told the hub all of it.
 */
function journalMessages(frame: SessionFrame): Record<string, unknown>[] {
  const data = frame.data;
  if (typeof data !== 'object' || data === null) return [];
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const messages: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === 'message') messages.push(candidate);
  }
  return messages;
}

/** Resolves a protocol transcript item back to Pi's durable session-tree entry id. */
function rewindEntryId(journal: readonly Record<string, unknown>[], itemId: string): string | undefined {
  for (const entry of journal.toReversed()) {
    if (entry.type !== 'message' || typeof entry.id !== 'string') continue;
    const message = entry.message;
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.id === itemId) return entry.id;
    if (entry.id === itemId) return entry.id;
    if (typeof record.timestamp === 'number' && itemId === `user-${String(record.timestamp)}`) return entry.id;
  }
  return undefined;
}

function resolvedCommand(managed: ManagedSession, frame: SessionFrame): SessionFrame {
  if (frame.type !== 'rewind') return frame;
  if (typeof frame.itemId !== 'string' || frame.itemId === '') throw new Error('The message has no rewind identity.');
  const entryId = rewindEntryId(managed.journal, frame.itemId);
  if (entryId === undefined) throw new Error('The selected message is not available in the session tree.');
  return { type: 'navigate_tree', entryId };
}

/**
 * Whether a journal entry is one no live frame reports.
 *
 * Pi publishes a frame for everything the agent does, but a user message only
 * ever reaches the journal: the agent did not produce it. That is invisible
 * when something other than a cockpit sends it, which is how autonomous voice
 * prompts the agent with what it heard. The catalog entry is here because
 * re-reading it only replaces a projection, so a refresh cannot double it.
 */
function isUnreportedEntry(entry: Record<string, unknown>): boolean {
  if (entry.type === 'custom') {
    return entry.customType === MINOR_MODE_ENTRY_TYPE || entry.customType === CONTEXT_ENTRY_TYPE;
  }
  const message = entry.message;
  if (typeof message !== 'object' || message === null) return false;
  return (message as { role?: unknown }).role === 'user';
}

/** Where an entry sits in the retained journal, or -1 when this hub never held it. */
function indexOfEntry(journal: readonly Record<string, unknown>[], id: string): number {
  return journal.findIndex((entry) => entry.id === id);
}

function readTokenFile(record: SessionRecord): string {
  return fs.readFileSync(record.tokenFile, 'utf8').trim();
}

function attachRelevantChanged(previous: SessionRecord, next: SessionRecord): boolean {
  return previous.socketPath !== next.socketPath || previous.tokenFile !== next.tokenFile || previous.pid !== next.pid;
}

function scopeOf(record: SessionRecord): HubSessionScope {
  return { sessionId: record.id, cwd: record.cwd };
}

function sessionApiPath(request: HubSessionApiRequest): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.basePath)) throw new Error('Invalid session API base path.');
  if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('#'))
    throw new Error('Invalid session API path.');
  return `/api/plugin/${request.basePath}${request.path}`;
}

const MODE_ACTIVATIONS = new Set(['inactive', 'activating', 'active', 'deactivating']);

/** Reads only the journaled host projection, without importing an owning mode package. */
function planStateFromProjection(frame: SessionFrame | undefined): PlanSaveState {
  if (frame === undefined) return 'unavailable';
  const replayed = frame.frame;
  const projected =
    frame.type === REPLAY_TYPE && typeof replayed === 'object' && replayed !== null && !Array.isArray(replayed)
      ? (replayed as SessionFrame)
      : frame;
  if (projected.type !== ENTRY_APPENDED_TYPE || typeof projected.entry !== 'object' || projected.entry === null) {
    return 'unavailable';
  }
  const entry = projected.entry as Record<string, unknown>;
  if (entry.type !== 'custom' || entry.customType !== MINOR_MODE_ENTRY_TYPE) return 'unavailable';
  const data = entry.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'unavailable';
  const projection = data as Record<string, unknown>;
  if (projection.version !== 1 || !Number.isInteger(projection.revision) || !Array.isArray(projection.modes)) {
    return 'unavailable';
  }
  let planActivation: string | undefined;
  for (const rawMode of projection.modes) {
    if (typeof rawMode !== 'object' || rawMode === null || Array.isArray(rawMode)) return 'unavailable';
    const mode = rawMode as Record<string, unknown>;
    if (typeof mode.id !== 'string' || typeof mode.activation !== 'string' || !MODE_ACTIVATIONS.has(mode.activation)) {
      return 'unavailable';
    }
    if (mode.id === 'plan') planActivation = mode.activation;
  }
  return planActivation === undefined || planActivation === 'inactive' ? 'allowed' : 'locked';
}
/**
 * Holds the hub's live view of every registered session.
 *
 * One attachment per session: the hub is "the one client" each socket allows,
 * and every page multiplexes behind it. Presence is reduced from the frame
 * stream so the rail describes sessions nobody is viewing, and a bounded ring
 * per session gives late pages their history, since a permanently attached
 * socket never fills the server-side backlog. Session data beyond the agent
 * stream comes from channels: each one watches its own source and publishes
 * per-session payloads the hub fans out by frame type.
 */
export function createSessionHub(options: SessionHubOptions): SessionHub {
  const sessions = new Map<string, ManagedSession>();
  const hubChannels = new Map<string, StartedChannel>();
  const listeners = new Set<(event: HubEvent) => void>();
  const readGit = options.readGit;
  const restoreLimit = options.restoreLimit ?? DEFAULT_RESTORE_LIMIT;
  const journalLimit = options.journalLimit ?? DEFAULT_JOURNAL_LIMIT;
  const signal =
    options.signal ??
    ((pid: number): void => {
      process.kill(pid, 'SIGTERM');
    });
  let closed = false;
  const emitTelemetry = (event: string, attributes: Record<string, string | number | boolean>): void => {
    void options.telemetry?.recordEvent(event, attributes);
  };
  const emit = (event: HubEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const stopSession = (sessionId: string): StopOutcome => {
    const managed = sessions.get(sessionId);
    if (!managed) return { ok: false, code: 'unknown', error: 'Unknown session.' };
    // Single-session mode records this very process; killing it would take
    // the cockpit down with the session.
    if (managed.record.pid === process.pid) {
      return { ok: false, code: 'self', error: 'This session hosts the cockpit; stop it from its own terminal.' };
    }
    try {
      signal(managed.record.pid);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, code: 'signal_failed', error: `Could not signal the session server: ${reason}` };
    }
    options.onNotice?.(`asked session ${sessionId} to stop`);
    return { ok: true };
  };

  /**
   * Waits for a stopped session to withdraw its registry record.
   *
   * The replacement reuses the socket path, so it must not start until the
   * previous server has let go of it; the record going is that signal.
   */
  const awaitWithdrawal = async (sessionId: string): Promise<boolean> => {
    const deadline = Date.now() + (options.restartWaitMs ?? DEFAULT_RESTART_WAIT_MS);
    while (sessions.has(sessionId)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, options.restartPollMs ?? DEFAULT_RESTART_POLL_MS));
    }
    return true;
  };

  const toSummary = (managed: ManagedSession): SessionSummary => {
    let webComposition: SessionWebComposition | undefined;
    try {
      webComposition = options.webComposition?.(
        managed.record,
        managed.channels.map((channel) => channel.frameType),
      );
    } catch (error) {
      options.onNotice?.(
        `session ${managed.record.id} plugin composition unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return {
      id: managed.record.id,
      name: managed.presence.sessionName ?? managed.record.name,
      cwd: managed.record.cwd,
      createdAt: managed.record.createdAt,
      updatedAt: managed.presence.updatedAt,
      phase: managed.presence.phase,
      phaseSince: managed.presence.phaseSince,
      attach: managed.attach,
      ...(managed.attachReason === undefined ? {} : { attachReason: managed.attachReason }),
      pendingMessageCount: managed.presence.pendingMessageCount,
      everPrompted: managed.presence.everPrompted,
      awaitingInput: managed.presence.awaitingInput,
      ...(managed.presence.lastSettledAt === undefined ? {} : { lastSettledAt: managed.presence.lastSettledAt }),
      socketPath: managed.record.socketPath,
      ...(managed.record.apiSocketPath === undefined ? {} : { apiSocketPath: managed.record.apiSocketPath }),
      ...(managed.git === undefined ? {} : { git: managed.git }),
      ...(webComposition === undefined ? {} : { webComposition }),
    };
  };

  const pushSummary = (managed: ManagedSession): void => {
    const summary = toSummary(managed);
    const json = JSON.stringify(summary);
    if (json === managed.lastSummaryJson) return;
    managed.lastSummaryJson = json;
    emit({ kind: 'upsert', session: summary });
  };

  const hubHost = (frameType: string): HubChannelHost => ({
    sessions: () => [...sessions.values()].map((managed) => scopeOf(managed.record)),
    publish: (sessionId, payload) => {
      if (closed || !sessions.has(sessionId)) return;
      emit({ kind: 'channel', frameType, sessionId, payload });
    },
    publishToConnection: (connectionId, sessionId, payload) => {
      if (closed || connectionId === '' || !sessions.has(sessionId)) return false;
      emit({ kind: 'channel', frameType, sessionId, payload, connectionId });
      return true;
    },
    requestSessionApi: async (requestedScope, request) => {
      const current = sessions.get(requestedScope.sessionId);
      if (
        closed ||
        current === undefined ||
        current.record.cwd !== requestedScope.cwd ||
        current.record.apiSocketPath === undefined
      ) {
        return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
      }
      const token = readTokenFile(current.record);
      const headers = new Headers({ authorization: `Bearer ${token}` });
      return await proxyToSocket({
        socketPath: current.record.apiSocketPath,
        path: sessionApiPath(request),
        method: request.method,
        headers,
        body: request.body ?? null,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
    ...(options.computerUse === undefined ? {} : { computerUse: options.computerUse }),
    onNotice: (message) => options.onNotice?.(message),
  });

  const attachHubChannel = (managed: ManagedSession, started: StartedChannel): void => {
    if (managed.channels.some((candidate) => candidate.frameType === started.frameType)) return;
    managed.channels.push(started);
    const scope = scopeOf(managed.record);
    const payload = started.source.payloadFor(scope);
    if (payload !== undefined)
      emit({ kind: 'channel', frameType: started.frameType, sessionId: scope.sessionId, payload });
    pushSummary(managed);
  };

  const startHubChannel = (channel: WebHubChannel): StartedChannel | undefined => {
    const existing = hubChannels.get(channel.frameType);
    if (existing !== undefined) return existing;
    let source: HubChannelSource;
    try {
      source = channel.start(hubHost(channel.frameType));
    } catch (error) {
      options.onNotice?.(
        `web hub channel '${channel.frameType}' failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
    const started: StartedChannel = { channel, frameType: channel.frameType, source, lifecycle: 'hub' };
    hubChannels.set(channel.frameType, started);
    for (const managed of sessions.values()) {
      try {
        source.sessionAdded?.(scopeOf(managed.record));
      } catch (error) {
        options.onNotice?.(
          `web hub channel '${channel.frameType}' failed for session ${managed.record.id} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return started;
  };

  const closeSessionChannels = (managed: ManagedSession): void => {
    for (const started of managed.channels) {
      if (started.lifecycle === 'hub') continue;
      started.source.sessionRemoved?.(managed.record.id);
      started.source.close();
    }
    managed.channels = [];
  };

  const startSessionChannels = async (managed: ManagedSession): Promise<void> => {
    const token = managed.channelLoadToken;
    let definitions: readonly WebHubChannel[];
    try {
      const dynamic = options.loadChannels === undefined ? [] : await options.loadChannels(managed.record);
      definitions = [...(options.channels ?? []), ...dynamic];
    } catch (error) {
      options.onNotice?.(
        `session ${managed.record.id} hub plugins unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    if (closed || sessions.get(managed.record.id) !== managed || managed.channelLoadToken !== token) return;

    const seen = new Set<string>();
    const scope = scopeOf(managed.record);
    for (const channel of definitions) {
      if (seen.has(channel.frameType)) {
        options.onNotice?.(
          `duplicate web channel '${channel.frameType}' dropped for session ${managed.record.id}; frame types are session-local`,
        );
        continue;
      }
      seen.add(channel.frameType);
      if (channel.lifecycle === 'hub') {
        try {
          const started = startHubChannel(channel);
          if (started !== undefined) attachHubChannel(managed, started);
        } catch (error) {
          options.onNotice?.(
            `web hub channel '${channel.frameType}' failed for session ${managed.record.id} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        continue;
      }
      try {
        const source = channel.start({
          sessions: () => [scopeOf(managed.record)],
          publish: (sessionId, payload) => {
            if (closed || sessionId !== managed.record.id) return;
            emit({ kind: 'channel', frameType: channel.frameType, sessionId, payload });
          },
          publishToConnection: (connectionId, sessionId, payload) => {
            if (closed || connectionId === '' || sessionId !== managed.record.id) return false;
            emit({ kind: 'channel', frameType: channel.frameType, sessionId, payload, connectionId });
            return true;
          },
          requestSessionApi: async (requestedScope, request) => {
            const current = sessions.get(requestedScope.sessionId);
            if (
              current !== managed ||
              current.record.cwd !== requestedScope.cwd ||
              current.record.apiSocketPath === undefined
            ) {
              return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
            }
            const token = readTokenFile(current.record);
            const headers = new Headers({ authorization: `Bearer ${token}` });
            return await proxyToSocket({
              socketPath: current.record.apiSocketPath,
              path: sessionApiPath(request),
              method: request.method,
              headers,
              body: request.body ?? null,
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
          },
          ...(options.computerUse === undefined ? {} : { computerUse: options.computerUse }),
          onNotice: (message) => options.onNotice?.(message),
        });
        managed.channels.push({ channel, frameType: channel.frameType, source, lifecycle: 'session' });
        source.sessionAdded?.(scope);
        const payload = source.payloadFor(scope);
        if (payload !== undefined)
          emit({ kind: 'channel', frameType: channel.frameType, sessionId: scope.sessionId, payload });
      } catch (error) {
        options.onNotice?.(
          `web channel '${channel.frameType}' failed for session ${managed.record.id} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    pushSummary(managed);
  };

  const refreshGit = (managed: ManagedSession): void => {
    if (!readGit) return;
    void readGit(managed.record.cwd).then((git) => {
      if (closed || sessions.get(managed.record.id) !== managed) return;
      managed.git = git;
      pushSummary(managed);
    });
  };

  const startAttachment = (managed: ManagedSession): void => {
    let token: string;
    try {
      token = readTokenFile(managed.record);
    } catch (error) {
      // The record beat the token file, or perms are off; the registry poll
      // re-runs reconcile, which retries this until it works.
      managed.attachment = undefined;
      managed.attach = 'closed';
      managed.attachReason = `The token file is unreadable: ${error instanceof Error ? error.message : String(error)}`;
      pushSummary(managed);
      return;
    }
    const connect = (trace?: DoomTraceContext): SessionAttachment =>
      attachToSession({
        socketPath: managed.record.socketPath,
        ...(managed.record.apiSocketPath === undefined ? {} : { apiSocketPath: managed.record.apiSocketPath }),
        token,
        trace,
        handlers: {
          onFrame: (frame) => {
            // The journal answer is the session's whole history. Each entry it
            // carries is re-emitted as the append it once was, so it travels the
            // same path as a live publish: into the ring for pages that
            // subscribe later, and straight out to the ones already watching.
            if (frame.type === 'response' && frame.command === GET_ENTRIES_COMMAND) {
              // Keep the whole transcript before publishing any of it: the page
              // pages back through this, and a read that arrives after the first
              // one is the newest picture of the same history.
              const whole = journalMessages(frame);
              managed.journal = whole.length > journalLimit ? whole.slice(-journalLimit) : whole;
              const restoredAt = new Date().toISOString();
              const refreshing = managed.restoredJournal;
              managed.restoredJournal = true;
              let presenceChanged = false;
              for (const entry of renderableJournalEntries(frame, restoreLimit)) {
                // Once the transcript is on the page the live stream carries
                // everything the agent does, and it carries it with no journal id
                // to match on. Publishing an answer twice is the cost of getting
                // that wrong, so a refresh only adds what no frame can carry.
                if (refreshing && !isUnreportedEntry(entry)) continue;
                const entryId = typeof entry.id === 'string' ? entry.id : undefined;
                if (entryId !== undefined) {
                  if (managed.emittedEntryIds.has(entryId)) continue;
                  managed.emittedEntryIds.add(entryId);
                }
                const restored = { type: ENTRY_APPENDED_TYPE, entry };
                const restoredKey = compositionEntryKey(entry);
                if (restoredKey === undefined) managed.ring.record(restored);
                else managed.uiProjections.set(restoredKey, restored);
                managed.frameCount += 1;
                emit({ kind: 'frame', sessionId: managed.record.id, frame: restored });
                const next = presenceAfterRestoredEntry(managed.presence, entry, restoredAt);
                presenceChanged ||= next !== managed.presence;
                managed.presence = next;
              }
              // The rail introduces a session by what it has done, so a restored
              // transcript has to reach the summary as well as the timeline.
              if (presenceChanged) pushSummary(managed);
              return;
            }
            const wasPhase = managed.presence.phase;
            const projectionKey = uiProjectionKey(frame);
            if (projectionKey === undefined) managed.ring.record(frame);
            else managed.uiProjections.set(projectionKey, frame);
            managed.frameCount += 1;
            const next = reducePresence(managed.presence, frame, new Date().toISOString());
            const changed = next !== managed.presence;
            managed.presence = next;
            emit({ kind: 'frame', sessionId: managed.record.id, frame });
            if (changed) pushSummary(managed);
            // A finished run is when the tree most plausibly changed.
            if (wasPhase !== 'idle' && next.phase === 'idle') refreshGit(managed);
            // A run boundary is the one moment a message can have been journalled
            // without any frame carrying it: an extension that prompts the agent
            // (autonomous voice dictating what it heard) sends the message
            // itself, so the only report of it is the journal. Re-reading here is
            // what puts it on the page; entries already published are skipped.
            if (wasPhase !== next.phase) managed.attachment?.send({ type: GET_ENTRIES_COMMAND });
          },
          onStatus: (status) => {
            managed.attach = status.state;
            managed.attachReason = status.reason;
            // A fresh attach is the moment to ask for the facts events do not
            // carry (name, pending count, streaming flags) and for the journal,
            // whose minor-mode entry this hub missed if the session predates it.
            if (status.state === 'attached') {
              managed.attachment?.send({ type: 'get_state' });
              managed.attachment?.send({ type: GET_ENTRIES_COMMAND });
            }
            if (status.state === 'attached') {
              emitTelemetry('web.session.attach', {
                'attach.state': status.state,
                replayed: status.replayed ?? 0,
                dropped: status.dropped ?? 0,
              });
            }
            pushSummary(managed);
          },
        },
      });
    if (options.telemetry === undefined) managed.attachment = connect();
    else {
      void options.telemetry.runInSpan('web.session_attach', { 'operation.name': 'web.session_attach' }, (trace) => {
        managed.attachment = connect(trace);
      });
    }
  };

  const startSession = (record: SessionRecord): void => {
    const managed: ManagedSession = {
      record,
      ring: createFrameRing(options.ringLimit),
      uiProjections: new Map<string, SessionFrame>(),
      journal: [],
      presence: initialPresence(new Date().toISOString()),
      attach: 'connecting',
      emittedEntryIds: new Set<string>(),
      restoredJournal: false,
      frameCount: 0,
      commands: Promise.resolve(),
      channels: [],
      channelLoadToken: Symbol(record.id),
    };
    sessions.set(record.id, managed);
    options.onNotice?.(`session ${record.id} (${record.name}) appeared`);
    emitTelemetry('web.session.lifecycle', { 'session.state': 'appeared', 'session.count': sessions.size });
    for (const started of hubChannels.values()) {
      try {
        started.source.sessionAdded?.(scopeOf(record));
      } catch (error) {
        options.onNotice?.(
          `web hub channel '${started.frameType}' failed for session ${record.id} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    startAttachment(managed);
    pushSummary(managed);
    refreshGit(managed);
    void startSessionChannels(managed);
  };

  const reconcile = (records: SessionRecord[]): void => {
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(record.id);
      const managed = sessions.get(record.id);
      if (!managed) {
        startSession(record);
        continue;
      }
      const reattach = attachRelevantChanged(managed.record, record);
      managed.record = record;
      if (reattach) {
        // A new pid means a restarted server, possibly with a rotated token.
        managed.attachment?.close();
        startAttachment(managed);
      } else if (!managed.attachment) {
        startAttachment(managed);
      }
      pushSummary(managed);
    }
    for (const [id, managed] of sessions) {
      if (seen.has(id)) continue;
      managed.attachment?.close();
      managed.channelLoadToken = Symbol(id);
      for (const started of hubChannels.values()) {
        try {
          started.source.sessionRemoved?.(id);
        } catch (error) {
          options.onNotice?.(
            `web hub channel '${started.frameType}' failed removing session ${id} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      closeSessionChannels(managed);
      sessions.delete(id);
      const ring = managed.ring.snapshot();
      emitTelemetry('web.session.summary', {
        frames: managed.frameCount,
        backlog_dropped: ring.dropped,
        'session.state': 'removed',
      });
      emitTelemetry('web.session.lifecycle', { 'session.state': 'removed', 'session.count': sessions.size });
      options.onNotice?.(`session ${id} left`);
      emit({ kind: 'removed', sessionId: id });
    }
  };

  for (const channel of options.channels ?? []) {
    if (channel.lifecycle === 'hub') startHubChannel(channel);
  }
  options.source.subscribe(reconcile);
  const gitTimer = readGit
    ? setInterval(() => {
        for (const managed of sessions.values()) refreshGit(managed);
      }, options.gitRefreshMs ?? GIT_REFRESH_MS)
    : undefined;

  return {
    records() {
      return [...sessions.values()].map((managed) => managed.record);
    },
    snapshot() {
      return [...sessions.values()]
        .sort(
          (left, right) =>
            left.record.createdAt.localeCompare(right.record.createdAt) ||
            left.record.id.localeCompare(right.record.id),
        )
        .map(toSummary);
    },
    planSaveState(sessionId) {
      const projection = sessions.get(sessionId)?.uiProjections.get(`entry:${MINOR_MODE_ENTRY_TYPE}`);
      return planStateFromProjection(projection);
    },
    stop: stopSession,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    backlog(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      const { frames: transientFrames, dropped } = managed.ring.snapshot();
      const frames = [...managed.uiProjections.values(), ...transientFrames];
      emitTelemetry('web.session.backlog', { frames: frames.length, dropped });
      return { type: SESSION_BACKLOG_TYPE, sessionId, frames, dropped };
    },
    history(sessionId, request) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      const limit = Math.max(1, Math.min(request.limit ?? HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE));
      // The page names the oldest entry it holds, so the window ends where the
      // page begins. An unknown cursor means the page holds something this hub
      // never sent, which a re-read can cause; answering from the end is the
      // honest fallback and the page reconciles by id.
      const end = request.before === undefined ? managed.journal.length : indexOfEntry(managed.journal, request.before);
      const stop = end < 0 ? managed.journal.length : end;
      const start = Math.max(0, stop - limit);
      const window = managed.journal.slice(start, stop);
      const oldest = window[0];
      return {
        type: HISTORY_PAGE_TYPE,
        sessionId,
        frames: window.map((entry) => ({ type: ENTRY_APPENDED_TYPE, entry })),
        cursor: typeof oldest?.id === 'string' ? oldest.id : null,
        hasMore: start > 0,
        ...(request.before === undefined ? {} : { before: request.before }),
      };
    },
    channelTypes() {
      return [
        ...new Set([
          ...hubChannels.keys(),
          ...[...sessions.values()].flatMap((managed) => managed.channels.map((channel) => channel.frameType)),
        ]),
      ];
    },
    channelFrames(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return [];
      const scope = scopeOf(managed.record);
      const frames: ChannelFrame[] = [];
      for (const channel of managed.channels) {
        const payload = channel.source.payloadFor(scope);
        if (payload !== undefined) frames.push({ type: channel.frameType, sessionId, payload });
      }
      return frames;
    },
    threadJournal(sessionId, threadId) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      const scope = scopeOf(managed.record);
      for (const channel of managed.channels) {
        const journal = channel.source.threadJournal?.(scope, threadId);
        if (journal !== undefined) return journal;
      }
      return undefined;
    },
    channelReceivesWithoutSubscription(sessionId, frameType) {
      return (
        sessions
          .get(sessionId)
          ?.channels.some(
            (candidate) => candidate.frameType === frameType && candidate.channel.receiveWithoutSubscription === true,
          ) ?? false
      );
    },
    receiveChannel(sessionId, frameType, payload, connectionId) {
      const managed = sessions.get(sessionId);
      if (managed === undefined || connectionId === '') return;
      const started =
        managed.channels.find((candidate) => candidate.frameType === frameType) ?? hubChannels.get(frameType);
      started?.channel.receive?.(scopeOf(managed.record), payload, { connectionId });
    },
    disconnectChannels(connectionId) {
      if (connectionId === '') return;
      for (const started of hubChannels.values()) started.channel.disconnected?.({ connectionId });
      for (const managed of sessions.values()) {
        for (const started of managed.channels) {
          if (started.lifecycle === 'session') started.channel.disconnected?.({ connectionId });
        }
      }
    },
    reloadChannels(sessionId) {
      const managed = sessions.get(sessionId);
      if (managed === undefined) return;
      managed.channelLoadToken = Symbol(sessionId);
      closeSessionChannels(managed);
      pushSummary(managed);
      void startSessionChannels(managed);
    },
    command(sessionId, frame) {
      const managed = sessions.get(sessionId);
      if (!managed) return;
      // A frame carrying images has to be resized before it is forwarded, which
      // is asynchronous, so every frame for this session queues behind the one
      // in flight. Two messages sent a keystroke apart must reach the agent in
      // the order they were sent, and only a single queue guarantees that.
      managed.commands = managed.commands
        .then(async () => {
          const resolved = resolvedCommand(managed, frame);
          const outgoing = carriesUserImages(resolved) ? await shrinkUserImages(resolved, userImageLimits()) : resolved;
          managed.attachment?.send(outgoing);
        })
        // A failed send must not poison the chain, or one bad frame would
        // silence every command this session is sent afterwards.
        .catch((error: unknown) => {
          options.onNotice?.(`command not delivered: ${error instanceof Error ? error.message : String(error)}`);
        });
      // The agent never announces that a dialog was answered, so an
      // extension_ui_request in the ring would reopen on every replay. This
      // synthetic close travels the same path as agent frames: it closes the
      // dialog on other live tabs now and on backlog replays forever after.
      if (frame.type === 'extension_ui_response' && typeof frame.id === 'string') {
        const closed = { type: DIALOG_ANSWERED_TYPE, id: frame.id };
        managed.ring.record(closed);
        emit({ kind: 'frame', sessionId: managed.record.id, frame: closed });
      }
      const next = presenceAfterCommand(managed.presence, frame, new Date().toISOString());
      if (next !== managed.presence) {
        managed.presence = next;
        pushSummary(managed);
      }
    },
    create(input) {
      if (!options.spawner) {
        return Promise.resolve({
          ok: false,
          code: 'invalid_request',
          error: 'This cockpit serves a fixed session and cannot create new ones.',
        });
      }
      return options.spawner.spawn(input);
    },
    async restart(sessionId, trace) {
      const spawner = options.spawner;
      if (!spawner) {
        return {
          ok: false,
          code: 'invalid_request',
          error: 'This cockpit serves a fixed session and cannot restart it.',
        };
      }
      const managed = sessions.get(sessionId);
      if (!managed) return { ok: false, code: 'invalid_request', error: 'Unknown session.' };
      // Read before the stop: once the record is withdrawn there is nothing
      // left to say where the replacement should go. The live session name wins
      // because the registry record still carries the name used at startup.
      const { cwd, socketPath } = managed.record;
      const name = managed.presence.sessionName ?? managed.record.name;
      const stopped = stopSession(sessionId);
      if (!stopped.ok) return { ok: false, code: 'invalid_request', error: stopped.error };
      if (!(await awaitWithdrawal(sessionId))) {
        return {
          ok: false,
          code: 'spawn_failed',
          error: 'The session did not stop in time; it was not restarted.',
        };
      }
      options.onNotice?.(`restarting session ${sessionId}`);
      return spawner.spawn({ cwd, name, sessionId, sessionDir: path.dirname(socketPath), trace });
    },
    async resume(sessionId, target, trace) {
      const spawner = options.spawner;
      if (!spawner) {
        return {
          ok: false,
          code: 'invalid_request',
          error: 'This cockpit serves a fixed session and cannot resume another thread.',
        };
      }
      const managed = sessions.get(sessionId);
      if (!managed) return { ok: false, code: 'invalid_request', error: 'Unknown session.' };
      if (target.sessionId === sessionId) return this.restart(sessionId, trace);
      if (sessions.has(target.sessionId)) {
        return { ok: false, code: 'invalid_request', error: 'That Pi thread is already running.' };
      }
      const { cwd, socketPath } = managed.record;
      const stopped = stopSession(sessionId);
      if (!stopped.ok) return { ok: false, code: 'invalid_request', error: stopped.error };
      if (!(await awaitWithdrawal(sessionId))) {
        return {
          ok: false,
          code: 'spawn_failed',
          error: 'The session did not stop in time; the selected thread was not resumed.',
        };
      }
      options.onNotice?.(`resuming Pi session ${target.sessionId} in place of ${sessionId}`);
      return spawner.spawn({
        cwd,
        name: target.name,
        sessionId: target.sessionId,
        sessionDir: path.dirname(socketPath),
        trace,
      });
    },
    close() {
      closed = true;
      options.source.close();
      if (gitTimer) clearInterval(gitTimer);
      for (const managed of sessions.values()) {
        managed.channelLoadToken = Symbol(managed.record.id);
        for (const started of hubChannels.values()) started.source.sessionRemoved?.(managed.record.id);
        closeSessionChannels(managed);
        managed.attachment?.close();
        emitTelemetry('web.session.summary', {
          frames: managed.frameCount,
          backlog_dropped: managed.ring.snapshot().dropped,
          'session.state': 'shutdown',
        });
      }
      for (const started of hubChannels.values()) started.source.close();
      hubChannels.clear();
      sessions.clear();
      listeners.clear();
    },
  };
}
