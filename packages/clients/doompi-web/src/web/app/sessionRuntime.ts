import {
  HISTORY_PAGE_TYPE,
  HUB_RESYNCED_TYPE,
  SESSION_BACKLOG_TYPE,
  SESSION_FRAME_TYPE,
  SESSION_REMOVED_TYPE,
  SESSION_UPSERT_TYPE,
  SESSIONS_SNAPSHOT_TYPE,
  subscribeFrame,
  THREAD_BACKLOG_TYPE,
  THREAD_FRAME_TYPE,
  unsubscribeFrame,
} from '../../types/hub.ts';
import { parseDoomNotificationEntry } from '../../types/notification.ts';
import {
  REMOTE_PAIRING_REQUEST_TYPE,
  REMOTE_STATE_TYPE,
  type RemoteAccessStateView,
} from '../../types/remoteAccess.ts';
import { dispatchChannelFrame, dropPluginSessionData } from '../lib/pluginRegistry.ts';
import { startProtocolRuntime } from './protocolRuntime.ts';
import { bindTransport, releaseTransport, sendHubFrame } from '../lib/transport.ts';
import { createSessionSocket, sessionSocketUrl } from '../lib/wsClient.ts';
import { deliverBrowserNotification } from '../lib/browserNotifications.ts';
import { browserReadyDuration, recordBrowserPerformance } from '../lib/browserTelemetry.ts';
import { claimDialogMenu, clearPendingMenu } from '../stores/menuStore.ts';
import { applyRemoteState } from '../stores/remoteAccessStore.ts';
import {
  applyHistoryPage,
  applySessionFrame,
  applyThreadFrame,
  dropSessionStore,
  refreshSessionFacts,
  resetSessionStore,
  seedHistoryCursor,
} from '../stores/sessionStore.ts';
import { dropThreads, resubscribeThreads, threadStoreKey } from '../stores/threadStore.ts';
import { dropTransientTabs } from '../stores/transientTabsStore.ts';
import {
  applySessionBacklog,
  applySessionRemoved,
  applySessionsSnapshot,
  applySessionUpsert,
  markSocketClosed,
  sessionsStore,
} from '../stores/sessionsStore.ts';

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
/** The journal id of the oldest restored entry, which is where paging back resumes. */
function oldestEntryId(frames: readonly Record<string, unknown>[]): string | null {
  for (const frame of frames) {
    if (frame.type !== 'entry_appended') continue;
    const entry = frame.entry;
    if (isRecord(entry) && typeof entry.id === 'string') return entry.id;
  }
  return null;
}

export function startSessionRuntime(): () => void {
  // The hub-side subscription this page currently holds; it dies with the
  // socket, which is why the snapshot handler re-subscribes.
  let subscribed: string | null = null;
  // The transcript comes from Pi's protocol; this socket keeps carrying what
  // the protocol has no shape for.
  const protocol = startProtocolRuntime();

  const syncSubscription = (force = false): void => {
    const { activeId, byId } = sessionsStore.state;
    const target = activeId !== null && activeId in byId ? activeId : null;
    protocol.focus(target);
    if (!force && target === subscribed) return;
    if (subscribed !== null && subscribed !== target) sendHubFrame(unsubscribeFrame(subscribed));
    subscribed = target;
    if (target !== null) sendHubFrame(subscribeFrame(target));
  };

  /** Both remote frames carry the same shape; only who receives them differs. */
  const applyRemoteFrame = (frame: Record<string, unknown>): void => {
    const state = frame.state;
    if (typeof state === 'object' && state !== null) applyRemoteState(state as RemoteAccessStateView);
  };

  const socket = createSessionSocket(sessionSocketUrl(window.location), {
    onFrame(frame) {
      switch (frame.type) {
        // Sync rebuilt the bundle this page is running. Nothing in a loaded
        // bundle notices its source moved, so the page picks the new one up.
        case HUB_RESYNCED_TYPE:
          window.location.reload();
          return;

        // Remote-access state is pushed rather than polled. The pairing
        // frame reaches local pages only, so a paired phone never sees the
        // approval queue and cannot approve the next device.
        case REMOTE_STATE_TYPE:
        case REMOTE_PAIRING_REQUEST_TYPE:
          applyRemoteFrame(frame);
          return;

        case SESSIONS_SNAPSHOT_TYPE:
          recordBrowserPerformance({ name: 'web.browser.ready', duration_ms: browserReadyDuration() });
          applySessionsSnapshot(frame);
          // A snapshot means a fresh socket; any prior subscription died with
          // the old one.
          syncSubscription(true);
          resubscribeThreads();
          return;
        case SESSION_UPSERT_TYPE:
          applySessionUpsert(frame);
          syncSubscription();
          return;
        case SESSION_REMOVED_TYPE: {
          if (typeof frame.sessionId !== 'string') return;
          applySessionRemoved(frame);
          dropSessionStore(frame.sessionId);
          dropPluginSessionData(frame.sessionId);
          dropThreads(frame.sessionId);
          dropTransientTabs(frame.sessionId);
          if (subscribed === frame.sessionId) subscribed = null;
          return;
        }
        case SESSION_BACKLOG_TYPE: {
          if (typeof frame.sessionId !== 'string' || !Array.isArray(frame.frames)) return;
          const sessionId = frame.sessionId;
          const frames = frame.frames.filter(isRecord);
          const dropped = typeof frame.dropped === 'number' ? frame.dropped : 0;
          recordBrowserPerformance({ name: 'web.browser.backlog', count: Math.min(10_000, frames.length + dropped) });
          applySessionBacklog(sessionId, frames.length, dropped);
          resetSessionStore(sessionId);
          for (const replayed of frames) applySessionFrame(sessionId, replayed);
          // Where the backlog starts is where paging back has to continue
          // from, so the oldest journal id it carried becomes the cursor.
          seedHistoryCursor(sessionId, oldestEntryId(frames));
          refreshSessionFacts(sessionId);
          return;
        }
        case HISTORY_PAGE_TYPE: {
          if (typeof frame.sessionId !== 'string' || !Array.isArray(frame.frames)) return;
          applyHistoryPage(frame.sessionId, frame.frames.filter(isRecord), {
            cursor: typeof frame.cursor === 'string' ? frame.cursor : null,
            hasMore: frame.hasMore === true,
          });
          return;
        }
        case SESSION_FRAME_TYPE: {
          if (typeof frame.sessionId !== 'string' || !isRecord(frame.frame)) return;
          const notification = parseDoomNotificationEntry(frame.frame);
          if (notification !== undefined) {
            void deliverBrowserNotification(frame.sessionId, notification.entryId, notification.data);
          }
          applySessionFrame(frame.sessionId, frame.frame);
          // A select the bar asked for becomes the bar's popover; the claim is
          // settled here, at frame time, so no surface renders it twice.
          if (frame.frame.type === 'extension_ui_request' && frame.frame.method === 'select') {
            claimDialogMenu(typeof frame.frame.id === 'string' ? frame.frame.id : '');
          }
          if (frame.frame.type === 'agent_settled') {
            clearPendingMenu();
            refreshSessionFacts(frame.sessionId);
          }
          return;
        }
        // A thread folds like a session of its own, under a key of its own;
        // the backlog replaces what the page had, the same as a session's.
        case THREAD_BACKLOG_TYPE: {
          if (typeof frame.sessionId !== 'string' || typeof frame.threadId !== 'string') return;
          if (!Array.isArray(frame.frames)) return;
          const key = threadStoreKey(frame.sessionId, frame.threadId);
          resetSessionStore(key);
          for (const replayed of frame.frames.filter(isRecord)) applyThreadFrame(key, replayed);
          return;
        }
        case THREAD_FRAME_TYPE: {
          if (typeof frame.sessionId !== 'string' || typeof frame.threadId !== 'string') return;
          if (!isRecord(frame.frame)) return;
          applyThreadFrame(threadStoreKey(frame.sessionId, frame.threadId), frame.frame);
          return;
        }
        default:
          // Any other frame type may be a plugin channel; unclaimed types are
          // dropped silently the way unknown frames always have been.
          dispatchChannelFrame(frame);
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
    protocol.stop();
    releaseTransport();
    socket.close();
  };
}
