import {
  HISTORY_PAGE_TYPE,
  HUB_RESYNCED_TYPE,
  RESOURCE_CATALOG_ENTRY_TYPE,
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
import { parseBundleUpdatedMessage } from '../../types/bundle.ts';
import { parseDoomNotificationEntry } from '../../types/notification.ts';
import {
  REMOTE_PAIRING_REQUEST_TYPE,
  REMOTE_STATE_TYPE,
  type RemoteAccessStateView,
} from '../../types/remoteAccess.ts';
import { dispatchChannelFrame } from '../lib/pluginRegistry.ts';
import { focusSessionWebPlugins, removeSessionWebPluginRuntime } from '../lib/pluginRuntime.ts';
import { startProtocolRuntime } from './protocolRuntime.ts';
import { bindTransport, notifyHubConnected, releaseTransport, sendHubFrame } from '../lib/transport.ts';
import { createSessionSocket, sessionSocketUrl } from '../lib/wsClient.ts';
import { deliverBrowserNotification } from '../lib/browserNotifications.ts';
import { browserReadyDuration, recordBrowserPerformance } from '../lib/browserTelemetry.ts';
import { dropComposerState, restoreComposerDrafts, saveComposerDrafts } from '../stores/composerStore.ts';
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
  beginSessionTransfer,
  completeSessionTransfer,
  markSocketClosed,
  sessionsStore,
  setActiveSession,
} from '../stores/sessionsStore.ts';

const VOICE_OWNERSHIP_FRAME_TYPE = 'voice_ownership';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function voiceOwner(frame: Record<string, unknown>): string | null | undefined {
  if (frame.type !== VOICE_OWNERSHIP_FRAME_TYPE || !isRecord(frame.payload)) return undefined;
  const activeSessionId = frame.payload.activeSessionId;
  return activeSessionId === null || typeof activeSessionId === 'string' ? activeSessionId : undefined;
}

function navigateToTransferredSession(sessionId: string): void {
  window.history.pushState(null, '', `/session/${encodeURIComponent(sessionId)}`);
  window.dispatchEvent(new Event('popstate'));
}

/** Every reload this runtime triggers is unasked for, so unsent text is kept first. */
function reloadForBundle(): void {
  saveComposerDrafts();
  window.location.reload();
}

async function refreshVerifiedBundle(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const serviceWorker = registration.active ?? navigator.serviceWorker.controller;
    if (serviceWorker === null) throw new Error('The trusted verifier is unavailable.');
    const channel = new MessageChannel();
    const result = await new Promise<unknown>((resolve) => {
      const timer = window.setTimeout(() => resolve(undefined), 120_000);
      channel.port1.addEventListener(
        'message',
        (event: MessageEvent<unknown>) => {
          window.clearTimeout(timer);
          resolve(event.data);
        },
        { once: true },
      );
      channel.port1.start();
      serviceWorker.postMessage({ type: 'doompi:refresh-bundle' }, [channel.port2]);
    });
    if (!isRecord(result) || result.ok !== true) throw new Error('The refreshed bundle was refused.');
    reloadForBundle();
  } catch {
    window.location.replace('/pair');
  }
}

/**
 * Reloads once the verifier reports a newer bundle it already committed.
 *
 * The worker revalidates on navigation, which is the only moment a returning
 * device reliably asks the host anything. By the time this message arrives the
 * replacement is verified and on disk, so the reload just picks it up.
 */
function watchVerifiedBundleUpdates(): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (parseBundleUpdatedMessage(event.data) === undefined) return;
    reloadForBundle();
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
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
  // A bundle update reloads this page mid-sentence; the text it saved is put
  // back before anything can render an empty composer over it.
  restoreComposerDrafts();
  const stopBundleWatch = watchVerifiedBundleUpdates();
  // The hub-side subscription this page currently holds; it dies with the
  // socket, which is why the snapshot handler re-subscribes.
  let subscribed: string | null = null;
  let currentVoiceOwner: string | null = null;
  let pendingVoiceTransferTarget: string | undefined;
  let pendingVoiceTransferFocus: Promise<void> | undefined;
  let deferredVoiceOwnershipFrame: Record<string, unknown> | undefined;
  // The transcript comes from Pi's protocol; this socket keeps carrying what
  // the protocol has no shape for.
  const protocol = startProtocolRuntime();

  const syncSubscription = (force = false): void => {
    const { activeId, byId } = sessionsStore.state;
    const target = activeId !== null && activeId in byId ? activeId : null;
    const focused = focusSessionWebPlugins(target, target === null ? undefined : byId[target].summary.webComposition);
    protocol.focus(target);
    if (deferredVoiceOwnershipFrame !== undefined && target !== null && pendingVoiceTransferTarget === target) {
      const deferred = deferredVoiceOwnershipFrame;
      const transferFocus = (pendingVoiceTransferFocus ??= focused);
      void transferFocus.then(() => {
        if (sessionsStore.state.activeId !== target || pendingVoiceTransferTarget !== target) return;
        deferredVoiceOwnershipFrame = undefined;
        pendingVoiceTransferFocus = undefined;
        pendingVoiceTransferTarget = undefined;
        dispatchChannelFrame(deferred);
        completeSessionTransfer(target);
      });
    }
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
        // Sync rebuilt the bundle this page is running. The trusted worker stages
        // and verifies the replacement before this page is allowed to reload it.
        case HUB_RESYNCED_TYPE:
          void refreshVerifiedBundle();
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
          notifyHubConnected();
          return;
        case SESSION_UPSERT_TYPE:
          applySessionUpsert(frame);
          syncSubscription();
          return;
        case SESSION_REMOVED_TYPE: {
          if (typeof frame.sessionId !== 'string') return;
          applySessionRemoved(frame);
          dropComposerState(frame.sessionId);
          dropSessionStore(frame.sessionId);
          removeSessionWebPluginRuntime(frame.sessionId);
          dropThreads(frame.sessionId);
          dropTransientTabs(frame.sessionId);
          if (subscribed === frame.sessionId) subscribed = null;
          syncSubscription();
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
          // A reload rebuilt the resource catalog, so the commands and skills
          // this page cached describe the selection it replaced. Pi reports a
          // reload no other way, which is why the runtime journals this entry.
          if (frame.frame.type === 'entry_appended') {
            const entry = isRecord(frame.frame.entry) ? frame.frame.entry : undefined;
            if (entry?.type === 'custom' && entry.customType === RESOURCE_CATALOG_ENTRY_TYPE) {
              refreshSessionFacts(frame.sessionId);
            }
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
        default: {
          // A voice handoff must focus the destination plugin runtime before its
          // ownership frame starts capture there. Otherwise route-driven plugin
          // teardown disconnects the fresh capture and leaves it only looking live.
          const owner = voiceOwner(frame);
          if (owner !== undefined) {
            const transfer = currentVoiceOwner !== null && owner !== null && owner !== currentVoiceOwner;
            currentVoiceOwner = owner;
            if (transfer) {
              pendingVoiceTransferTarget = owner;
              pendingVoiceTransferFocus = undefined;
              deferredVoiceOwnershipFrame = frame;
              beginSessionTransfer(owner);
              navigateToTransferredSession(owner);
              setActiveSession(owner);
              syncSubscription();
              return;
            }
            if (pendingVoiceTransferTarget !== undefined && pendingVoiceTransferTarget !== owner) {
              const cancelledTarget = pendingVoiceTransferTarget;
              pendingVoiceTransferTarget = undefined;
              pendingVoiceTransferFocus = undefined;
              deferredVoiceOwnershipFrame = undefined;
              completeSessionTransfer(cancelledTarget);
            }
            if (pendingVoiceTransferTarget === owner) {
              deferredVoiceOwnershipFrame = frame;
              return;
            }
          }
          // Any other frame type may be a plugin channel; unclaimed types are
          // dropped silently the way unknown frames always have been.
          dispatchChannelFrame(frame);
          return;
        }
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
    stopBundleWatch();
    subscription.unsubscribe();
    void focusSessionWebPlugins(null, undefined);
    protocol.stop();
    releaseTransport();
    socket.close();
  };
}
