import fs from 'node:fs';
import type { ChannelFrame, HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
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
  MINOR_MODE_ENTRY_TYPE,
  SESSION_BACKLOG_TYPE,
  type SessionBacklogFrame,
  type SessionGitStatus,
  type SessionSummary,
} from '../types/hub.ts';
import type { SessionRecord } from '../types/registry.ts';
import type { BridgeState, SessionFrame } from '../types/session.ts';
import type { RecordSource } from './registryWatcher.ts';
import type { SessionSpawner, SpawnOutcome, SpawnSessionInput } from './serverSpawner.ts';
import { attachToSession } from './sessionSocketClient.ts';

const GIT_REFRESH_MS = 10_000;
const GET_ENTRIES_COMMAND = 'get_entries';
/**
 * How much of a long transcript a fresh attach restores. The ring holds 512
 * frames and live ones have to fit beside the history, so a session with
 * thousands of messages gives up its oldest rather than its newest.
 */
const DEFAULT_RESTORE_LIMIT = 300;
const ENTRY_APPENDED_TYPE = 'entry_appended';

export type HubEvent =
  | { kind: 'upsert'; session: SessionSummary }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'frame'; sessionId: string; frame: SessionFrame }
  | { kind: 'channel'; frameType: string; sessionId: string; payload: unknown };

export interface SessionHubOptions {
  source: RecordSource;
  /** Absent in single-session mode, where creating sessions is not offered. */
  spawner?: SessionSpawner;
  /** Injectable for tests; defaults to asking git about the session cwd. */
  readGit?: (cwd: string) => Promise<SessionGitStatus | undefined>;
  /** Injectable for the fixed single-session mode, which already holds the token. */
  readToken?: (record: SessionRecord) => string;
  /** The hub's data channels (built-in and plugin-provided sources). */
  channels?: readonly WebHubChannel[];
  /** Injectable for tests; defaults to SIGTERM, which doompi-server treats as a clean stop. */
  signal?: (pid: number) => void;
  ringLimit?: number;
  /** Journalled messages restored per session on attach; the rest of a long transcript stays on disk. */
  restoreLimit?: number;
  gitRefreshMs?: number;
  onNotice?: (message: string) => void;
}

export type StopOutcome = { ok: true } | { ok: false; code: 'unknown' | 'self' | 'signal_failed'; error: string };

export interface SessionHub {
  snapshot(): SessionSummary[];
  /** Asks a session's server to exit; the session leaves once its record is withdrawn. */
  stop(sessionId: string): StopOutcome;
  /** Streams every change; pages filter frame events by their subscriptions. */
  onEvent(listener: (event: HubEvent) => void): () => void;
  /** Recent history for one session, or undefined for an unknown id. */
  backlog(sessionId: string): SessionBacklogFrame | undefined;
  /** Frame types of the loaded data channels, for the hello frame. */
  channelTypes(): string[];
  /** Every channel's subscribe-time snapshot for one session; empty for an unknown id. */
  channelFrames(sessionId: string): ChannelFrame[];
  command(sessionId: string, frame: SessionFrame): void;
  create(input: SpawnSessionInput): Promise<SpawnOutcome>;
  close(): void;
}

interface ManagedSession {
  record: SessionRecord;
  attachment?: SessionAttachment;
  ring: FrameRing;
  presence: SessionPresence;
  attach: BridgeState;
  attachReason?: string;
  git?: SessionGitStatus;
  lastSummaryJson?: string;
}

interface StartedChannel {
  frameType: string;
  source: HubChannelSource;
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
  let minorModes: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === 'message') messages.push(candidate);
    else if (candidate.type === 'custom' && candidate.customType === MINOR_MODE_ENTRY_TYPE) minorModes = candidate;
  }

  // The ring is bounded and live frames must still fit, so only the tail of a
  // long transcript is restored; the ring's own drop counter reports the rest.
  const kept = messages.length > limit ? messages.slice(-limit) : messages;
  return minorModes === undefined ? kept : [...kept, minorModes];
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
  const listeners = new Set<(event: HubEvent) => void>();
  const readGit = options.readGit;
  const readToken = options.readToken ?? readTokenFile;
  const restoreLimit = options.restoreLimit ?? DEFAULT_RESTORE_LIMIT;
  const signal =
    options.signal ??
    ((pid: number): void => {
      process.kill(pid, 'SIGTERM');
    });
  let closed = false;

  const emit = (event: HubEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const startedChannels: StartedChannel[] = (options.channels ?? []).map((channel) => ({
    frameType: channel.frameType,
    source: channel.start({
      sessions: () => [...sessions.values()].map((managed) => scopeOf(managed.record)),
      publish: (sessionId, payload) => {
        if (closed) return;
        emit({ kind: 'channel', frameType: channel.frameType, sessionId, payload });
      },
      onNotice: (message) => options.onNotice?.(message),
    }),
  }));

  const toSummary = (managed: ManagedSession): SessionSummary => ({
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
    ...(managed.git === undefined ? {} : { git: managed.git }),
  });

  const pushSummary = (managed: ManagedSession): void => {
    const summary = toSummary(managed);
    const json = JSON.stringify(summary);
    if (json === managed.lastSummaryJson) return;
    managed.lastSummaryJson = json;
    emit({ kind: 'upsert', session: summary });
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
      token = readToken(managed.record);
    } catch (error) {
      // The record beat the token file, or perms are off; the registry poll
      // re-runs reconcile, which retries this until it works.
      managed.attachment = undefined;
      managed.attach = 'closed';
      managed.attachReason = `The token file is unreadable: ${error instanceof Error ? error.message : String(error)}`;
      pushSummary(managed);
      return;
    }
    managed.attachment = attachToSession({
      socketPath: managed.record.socketPath,
      token,
      handlers: {
        onFrame: (frame) => {
          // The journal answer is the session's whole history. Each entry it
          // carries is re-emitted as the append it once was, so it travels the
          // same path as a live publish: into the ring for pages that
          // subscribe later, and straight out to the ones already watching.
          if (frame.type === 'response' && frame.command === GET_ENTRIES_COMMAND) {
            const restoredAt = new Date().toISOString();
            let presenceChanged = false;
            for (const entry of renderableJournalEntries(frame, restoreLimit)) {
              const restored = { type: ENTRY_APPENDED_TYPE, entry };
              managed.ring.record(restored);
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
          managed.ring.record(frame);
          const next = reducePresence(managed.presence, frame, new Date().toISOString());
          const changed = next !== managed.presence;
          managed.presence = next;
          emit({ kind: 'frame', sessionId: managed.record.id, frame });
          if (changed) pushSummary(managed);
          // A finished run is when the tree most plausibly changed.
          if (wasPhase !== 'idle' && next.phase === 'idle') refreshGit(managed);
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
          pushSummary(managed);
        },
      },
    });
  };

  const startSession = (record: SessionRecord): void => {
    const managed: ManagedSession = {
      record,
      ring: createFrameRing(options.ringLimit),
      presence: initialPresence(new Date().toISOString()),
      attach: 'connecting',
    };
    sessions.set(record.id, managed);
    options.onNotice?.(`session ${record.id} (${record.name}) appeared`);
    startAttachment(managed);
    pushSummary(managed);
    refreshGit(managed);
    for (const channel of startedChannels) channel.source.sessionAdded?.(scopeOf(record));
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
      sessions.delete(id);
      for (const channel of startedChannels) channel.source.sessionRemoved?.(id);
      options.onNotice?.(`session ${id} left`);
      emit({ kind: 'removed', sessionId: id });
    }
  };

  options.source.subscribe(reconcile);
  const gitTimer = readGit
    ? setInterval(() => {
        for (const managed of sessions.values()) refreshGit(managed);
      }, options.gitRefreshMs ?? GIT_REFRESH_MS)
    : undefined;

  return {
    snapshot() {
      return [...sessions.values()]
        .sort(
          (left, right) =>
            left.record.createdAt.localeCompare(right.record.createdAt) ||
            left.record.id.localeCompare(right.record.id),
        )
        .map(toSummary);
    },
    stop(sessionId) {
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
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    backlog(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      const { frames, dropped } = managed.ring.snapshot();
      return { type: SESSION_BACKLOG_TYPE, sessionId, frames, dropped };
    },
    channelTypes() {
      return startedChannels.map((channel) => channel.frameType);
    },
    channelFrames(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return [];
      const scope = scopeOf(managed.record);
      const frames: ChannelFrame[] = [];
      for (const channel of startedChannels) {
        const payload = channel.source.payloadFor(scope);
        if (payload !== undefined) frames.push({ type: channel.frameType, sessionId, payload });
      }
      return frames;
    },
    command(sessionId, frame) {
      const managed = sessions.get(sessionId);
      if (!managed) return;
      managed.attachment?.send(frame);
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
    close() {
      closed = true;
      options.source.close();
      for (const channel of startedChannels) channel.source.close();
      if (gitTimer) clearInterval(gitTimer);
      for (const managed of sessions.values()) {
        managed.attachment?.close();
      }
      sessions.clear();
      listeners.clear();
    },
  };
}
