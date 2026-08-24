import fs from 'node:fs';
import { createFrameRing, type FrameRing } from '../services/frameRing.ts';
import {
  initialPresence,
  presenceAfterCommand,
  reducePresence,
  type SessionPresence,
} from '../services/sessionPresence.ts';
import { presentWorkflowRuns, runBelongsToSession, type ParsedWorkflowRun } from '../services/workflowRuns.ts';
import type { SessionAttachment } from '../types/bridge.ts';
import {
  SESSION_BACKLOG_TYPE,
  SUBAGENT_RUNS_TYPE,
  WORKFLOW_RUNS_TYPE,
  type SessionBacklogFrame,
  type SessionGitStatus,
  type SessionSummary,
  type SubagentRun,
  type SubagentRunsFrame,
  type WorkflowRunView,
  type WorkflowRunsFrame,
} from '../types/hub.ts';
import type { SessionRecord } from '../types/registry.ts';
import type { BridgeState, SessionFrame } from '../types/session.ts';
import type { RecordSource } from './registryWatcher.ts';
import type { SessionSpawner, SpawnOutcome, SpawnSessionInput } from './serverSpawner.ts';
import { attachToSession } from './sessionSocketClient.ts';
import { type SubagentRunsSource, watchSubagentRuns } from './subagentWatcher.ts';
import { watchWorkflowRuns } from './workflowWatcher.ts';

const GIT_REFRESH_MS = 10_000;

export type HubEvent =
  | { kind: 'upsert'; session: SessionSummary }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'frame'; sessionId: string; frame: SessionFrame }
  | { kind: 'runs'; sessionId: string; runs: SubagentRun[] }
  | { kind: 'workflows'; sessionId: string; runs: WorkflowRunView[] };

export interface SessionHubOptions {
  source: RecordSource;
  /** Absent in single-session mode, where creating sessions is not offered. */
  spawner?: SessionSpawner;
  /** Injectable for tests; defaults to asking git about the session cwd. */
  readGit?: (cwd: string) => Promise<SessionGitStatus | undefined>;
  /** Injectable for the fixed single-session mode, which already holds the token. */
  readToken?: (record: SessionRecord) => string;
  /** Injectable for tests; defaults to watching doom-team's run directory. */
  watchRuns?: typeof watchSubagentRuns;
  /** Injectable for tests; defaults to watching workflow-mcp's registry. */
  watchWorkflows?: typeof watchWorkflowRuns;
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
  /** The session's current subagent fleet, or undefined for an unknown id. */
  runsFor(sessionId: string): SubagentRunsFrame | undefined;
  /** The session's workflow runs, or undefined for an unknown id. */
  workflowsFor(sessionId: string): WorkflowRunsFrame | undefined;
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
  runs: SubagentRun[];
  runsSource?: SubagentRunsSource;
  workflows: WorkflowRunView[];
  lastWorkflowsJson?: string;
  lastSummaryJson?: string;
}

function readTokenFile(record: SessionRecord): string {
  return fs.readFileSync(record.tokenFile, 'utf8').trim();
}

function attachRelevantChanged(previous: SessionRecord, next: SessionRecord): boolean {
  return previous.socketPath !== next.socketPath || previous.tokenFile !== next.tokenFile || previous.pid !== next.pid;
}

/**
 * Holds the hub's live view of every registered session.
 *
 * One attachment per session: the hub is "the one client" each socket allows,
 * and every page multiplexes behind it. Presence is reduced from the frame
 * stream so the rail describes sessions nobody is viewing, and a bounded ring
 * per session gives late pages their history, since a permanently attached
 * socket never fills the server-side backlog.
 */
export function createSessionHub(options: SessionHubOptions): SessionHub {
  const sessions = new Map<string, ManagedSession>();
  const listeners = new Set<(event: HubEvent) => void>();
  const readGit = options.readGit;
  const readToken = options.readToken ?? readTokenFile;
  let closed = false;
  let workflowRuns: ParsedWorkflowRun[] = [];

  const emit = (event: HubEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const sessionWorkflows = (managed: ManagedSession): WorkflowRunView[] =>
    presentWorkflowRuns(
      workflowRuns
        .filter((run) => runBelongsToSession(run, { sessionId: managed.record.id, cwd: managed.record.cwd }))
        .map((run) => run.view),
      Date.now(),
    );

  const refreshWorkflows = (managed: ManagedSession, announce: boolean): void => {
    const runs = sessionWorkflows(managed);
    const json = JSON.stringify(runs);
    if (json === managed.lastWorkflowsJson) return;
    managed.lastWorkflowsJson = json;
    managed.workflows = runs;
    if (announce) emit({ kind: 'workflows', sessionId: managed.record.id, runs });
  };

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
      runs: [],
      workflows: [],
    };
    sessions.set(record.id, managed);
    options.onNotice?.(`session ${record.id} (${record.name}) appeared`);
    startAttachment(managed);
    pushSummary(managed);
    refreshGit(managed);
    // Quietly: no page can be subscribed before the upsert lands.
    refreshWorkflows(managed, false);
    managed.runsSource = (options.watchRuns ?? watchSubagentRuns)(record.id, (runs) => {
      if (closed || sessions.get(record.id) !== managed) return;
      managed.runs = runs;
      emit({ kind: 'runs', sessionId: record.id, runs });
    });
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
      managed.runsSource?.close();
      sessions.delete(id);
      options.onNotice?.(`session ${id} left`);
      emit({ kind: 'removed', sessionId: id });
    }
  };

  options.source.subscribe(reconcile);
  const workflowSource = (options.watchWorkflows ?? watchWorkflowRuns)((runs) => {
    if (closed) return;
    workflowRuns = runs;
    for (const managed of sessions.values()) refreshWorkflows(managed, true);
  });
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
    runsFor(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      return { type: SUBAGENT_RUNS_TYPE, sessionId, runs: managed.runs };
    },
    workflowsFor(sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed) return undefined;
      // Recomputed rather than cached so retention keeps moving between
      // registry changes; the cache only gates live announcements.
      return { type: WORKFLOW_RUNS_TYPE, sessionId, runs: sessionWorkflows(managed) };
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
      workflowSource.close();
      if (gitTimer) clearInterval(gitTimer);
      for (const managed of sessions.values()) {
        managed.attachment?.close();
        managed.runsSource?.close();
      }
      sessions.clear();
      listeners.clear();
    },
  };
}
