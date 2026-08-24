import {
  SESSION_BACKLOG_TYPE,
  SESSION_FRAME_TYPE,
  SESSION_REMOVED_TYPE,
  SESSION_UPSERT_TYPE,
  SESSIONS_SNAPSHOT_TYPE,
  SUBAGENT_RUNS_TYPE,
  subscribeFrame,
  unsubscribeFrame,
  WORKFLOW_RUNS_TYPE,
} from '../../types/hub.ts';
import { bindTransport, releaseTransport, sendHubFrame } from '../lib/transport.ts';
import { createSessionSocket, sessionSocketUrl } from '../lib/wsClient.ts';
import { applySessionFrame, dropSessionStore, refreshSessionFacts, resetSessionStore } from '../stores/sessionStore.ts';
import {
  applySessionBacklog,
  applySessionRemoved,
  applySessionsSnapshot,
  applySessionUpsert,
  markSocketClosed,
  sessionsStore,
} from '../stores/sessionsStore.ts';
import { applySubagentRuns, dropSubagentRuns } from '../stores/subagentsStore.ts';
import { applyWorkflowRuns, dropWorkflowRuns } from '../stores/workflowsStore.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wires the hub socket to the stores.
 *
 * One socket carries every session. The rail runs on hub summaries; the
 * timeline of the focused session is hydrated by subscribing, which replays
 * the hub's ring and then streams live frames. Session facts are pulled after
 * every replay and again once a run settles, because Pi reports model, stats
 * and commands on request rather than pushing them as events.
 */
export function startSessionRuntime(): () => void {
  // The hub-side subscription this page currently holds; it dies with the
  // socket, which is why the snapshot handler re-subscribes.
  let subscribed: string | null = null;

  const syncSubscription = (force = false): void => {
    const { activeId, byId } = sessionsStore.state;
    const target = activeId !== null && activeId in byId ? activeId : null;
    if (!force && target === subscribed) return;
    if (subscribed !== null && subscribed !== target) sendHubFrame(unsubscribeFrame(subscribed));
    subscribed = target;
    if (target !== null) sendHubFrame(subscribeFrame(target));
  };

  const socket = createSessionSocket(sessionSocketUrl(window.location), {
    onFrame(frame) {
      switch (frame.type) {
        case SESSIONS_SNAPSHOT_TYPE:
          applySessionsSnapshot(frame);
          // A snapshot means a fresh socket; any prior subscription died with
          // the old one.
          syncSubscription(true);
          return;
        case SESSION_UPSERT_TYPE:
          applySessionUpsert(frame);
          syncSubscription();
          return;
        case SESSION_REMOVED_TYPE: {
          if (typeof frame.sessionId !== 'string') return;
          applySessionRemoved(frame);
          dropSessionStore(frame.sessionId);
          dropSubagentRuns(frame.sessionId);
          dropWorkflowRuns(frame.sessionId);
          if (subscribed === frame.sessionId) subscribed = null;
          return;
        }
        case SUBAGENT_RUNS_TYPE:
          applySubagentRuns(frame);
          return;
        case WORKFLOW_RUNS_TYPE:
          applyWorkflowRuns(frame);
          return;
        case SESSION_BACKLOG_TYPE: {
          if (typeof frame.sessionId !== 'string' || !Array.isArray(frame.frames)) return;
          const sessionId = frame.sessionId;
          const frames = frame.frames.filter(isRecord);
          const dropped = typeof frame.dropped === 'number' ? frame.dropped : 0;
          applySessionBacklog(sessionId, frames.length, dropped);
          resetSessionStore(sessionId);
          for (const replayed of frames) applySessionFrame(sessionId, replayed);
          refreshSessionFacts(sessionId);
          return;
        }
        case SESSION_FRAME_TYPE: {
          if (typeof frame.sessionId !== 'string' || !isRecord(frame.frame)) return;
          applySessionFrame(frame.sessionId, frame.frame);
          if (frame.frame.type === 'agent_settled') refreshSessionFacts(frame.sessionId);
          return;
        }
        default:
          return;
      }
    },
    onOpen() {
      // The snapshot that follows the hub's hello is the real "connected".
    },
    onClose() {
      subscribed = null;
      markSocketClosed();
    },
  });

  bindTransport((frame) => socket.send(frame));
  // Focus changes come from routing; the runtime follows them with
  // subscribe/unsubscribe so features never touch the wire protocol.
  const subscription = sessionsStore.subscribe(() => syncSubscription());

  return () => {
    subscription.unsubscribe();
    releaseTransport();
    socket.close();
  };
}
