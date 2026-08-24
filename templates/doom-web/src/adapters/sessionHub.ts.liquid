import fs from 'node:fs';
import type { ChannelFrame, HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { createFrameRing, type FrameRing } from '../services/frameRing.ts';
import {
  initialPresence,
  presenceAfterCommand,
  reducePresence,
  type SessionPresence,
} from '../services/sessionPresence.ts';
import type { SessionAttachment } from '../types/bridge.ts';
import {
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
  ringLimit?: number;
  gitRefreshMs?: number;
  onNotice?: (message: string) => void;
}

export interface SessionHub {
  snapshot(): SessionSummary[];
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
          // carry (name, pending count, streaming flags).
          if (status.state === 'attached') managed.attachment?.send({ type: 'get_state' });
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
