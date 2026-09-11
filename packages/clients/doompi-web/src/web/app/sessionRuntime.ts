import { batch } from '@tanstack/store';
import {
  HISTORY_PAGE_TYPE,
  SESSION_BACKLOG_TYPE,
  HUB_RESYNCED_TYPE,
  RESOURCE_CATALOG_ENTRY_TYPE,
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
import { applyCaptureFrame, disconnectCaptures, pendingCaptureSessions } from '../stores/captureStore.ts';
import { bindSessionFileLinkModes } from '../stores/fileLinkModesStore.ts';
import { createProtocolHubSocket } from '../lib/protocolHubSocket.ts';
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
  beginSessionReplay,
  endSessionReplay,
  refreshSessionFacts,
  refreshSessionStats,
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

export function startSessionRuntime(): () => void {
  // A bundle update reloads this page mid-sentence; the text it saved is put
  // back before anything can render an empty composer over it.
  restoreComposerDrafts();
  const stopBundleWatch = watchVerifiedBundleUpdates();
  const stopFileLinkModes = bindSessionFileLinkModes();
  // Focus, voice ownership, and pending captures each own a hub subscription.
  // Socket loss ends captures; a fresh snapshot restores the remaining owners.
  const subscribed = new Set<string>();
  let currentVoiceOwner: string | null = null;
  let pendingVoiceTransferTarget: string | undefined;
  let pendingVoiceTransferFocus: Promise<void> | undefined;
  let deferredVoiceOwnershipFrame: Record<string, unknown> | undefined;
  const applyPresentationFrame = (sessionId: string, frame: Record<string, unknown>, replay: boolean): void => {
    applySessionFrame(sessionId, frame, { replay });
    if (replay) return;
    const notification = parseDoomNotificationEntry(frame);
    if (notification) void deliverBrowserNotification(sessionId, notification.entryId, notification.data);
    applyCaptureFrame(sessionId, frame);
    if (sessionId !== sessionsStore.state.activeId) return;
    if (frame.type === 'extension_ui_request' && frame.method === 'select')
      claimDialogMenu(typeof frame.id === 'string' ? frame.id : '');
    if (frame.type === 'entry_appended') {
      const entry = isRecord(frame.entry) ? frame.entry : undefined;
      if (entry?.type === 'custom' && entry.customType === RESOURCE_CATALOG_ENTRY_TYPE) refreshSessionFacts(sessionId);
    }
    if (frame.type === 'message_end') refreshSessionStats(sessionId);
    if (frame.type === 'agent_settled') {
      clearPendingMenu();
      refreshSessionFacts(sessionId);
    }
  };
  const protocol = startProtocolRuntime(window.location, applyPresentationFrame);

  const clearSubscriptions = (): void => {
    for (const sessionId of subscribed) endSessionReplay(sessionId);
    subscribed.clear();
  };

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

    const desired = new Set<string>();
    if (target !== null) desired.add(target);
    if (currentVoiceOwner !== null && currentVoiceOwner in byId) desired.add(currentVoiceOwner);
    for (const sessionId of pendingCaptureSessions.state) {
      if (sessionId in byId) desired.add(sessionId);
    }
    if (force) clearSubscriptions();
    for (const sessionId of subscribed) {
      if (desired.has(sessionId)) continue;
      subscribed.delete(sessionId);
      endSessionReplay(sessionId);
      disconnectCaptures(sessionId);
      sendHubFrame(unsubscribeFrame(sessionId));
    }
    for (const sessionId of desired) {
      if (subscribed.has(sessionId)) continue;
      subscribed.add(sessionId);
      sendHubFrame(subscribeFrame(sessionId));
    }
  };

  /** Both remote frames carry the same shape; only who receives them differs. */
  const applyRemoteFrame = (frame: Record<string, unknown>): void => {
    const state = frame.state;
    if (typeof state === 'object' && state !== null) applyRemoteState(state as RemoteAccessStateView);
  };

  const socket = createProtocolHubSocket(protocol.client, {
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
          disconnectCaptures(frame.sessionId);
          applySessionRemoved(frame);
          dropComposerState(frame.sessionId);
          dropSessionStore(frame.sessionId);
          removeSessionWebPluginRuntime(frame.sessionId);
          dropThreads(frame.sessionId);
          dropTransientTabs(frame.sessionId);
          subscribed.delete(frame.sessionId);
          if (currentVoiceOwner === frame.sessionId) currentVoiceOwner = null;
          syncSubscription();
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
        case SESSION_BACKLOG_TYPE: {
          const sessionId = frame.sessionId;
          if (typeof sessionId !== 'string' || !Array.isArray(frame.frames)) return;
          const frames = frame.frames.filter(isRecord);
          const firstEntry = frames.find((item) => item.type === 'entry_appended' && isRecord(item.entry));
          const firstEntryId =
            isRecord(firstEntry?.entry) && typeof firstEntry.entry.id === 'string' ? firstEntry.entry.id : null;
          beginSessionReplay(sessionId);
          try {
            batch(() => {
              resetSessionStore(sessionId);
              for (const replayed of frames) applyPresentationFrame(sessionId, replayed, true);
            });
          } finally {
            endSessionReplay(sessionId);
          }
          seedHistoryCursor(sessionId, firstEntryId);
          applySessionBacklog(
            sessionId,
            frames.length,
            typeof frame.dropped === 'number' && Number.isFinite(frame.dropped) ? frame.dropped : 0,
          );
          if (sessionId === sessionsStore.state.activeId) refreshSessionFacts(sessionId);
          return;
        }
        case SESSION_FRAME_TYPE: {
          // Hub-wide notifications cover sessions that are not the focused presentation.
          if (
            typeof frame.sessionId !== 'string' ||
            !isRecord(frame.frame) ||
            frame.sessionId === sessionsStore.state.activeId
          )
            return;
          applyPresentationFrame(frame.sessionId, frame.frame, false);
          return;
        }
        // A thread folds like a session of its own, under a key of its own;
        // the backlog replaces what the page had, the same as a session's.
        case THREAD_BACKLOG_TYPE: {
          if (typeof frame.sessionId !== 'string' || typeof frame.threadId !== 'string') return;
          if (!Array.isArray(frame.frames)) return;
          const key = threadStoreKey(frame.sessionId, frame.threadId);
          const frames = frame.frames.filter(isRecord);
          batch(() => {
            resetSessionStore(key);
            for (const replayed of frames) applyThreadFrame(key, replayed);
          });
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
          if (owner !== undefined) syncSubscription();
          return;
        }
      }
    },
    onOpen() {
      // The snapshot that follows the hub's hello is the real "connected".
    },
    onClose() {
      disconnectCaptures();
      markSocketClosed();
      clearSubscriptions();
    },
  });

  bindTransport((frame) => socket.send(frame));
  // Focus changes come from routing; the runtime follows them with
  // subscribe/unsubscribe so features never touch the wire protocol.
  const subscription = sessionsStore.subscribe(() => syncSubscription());
  const captureSubscription = pendingCaptureSessions.subscribe(() => syncSubscription());

  return () => {
    stopBundleWatch();
    stopFileLinkModes();
    subscription.unsubscribe();
    captureSubscription.unsubscribe();
    clearSubscriptions();
    void focusSessionWebPlugins(null, undefined);
    protocol.stop();
    disconnectCaptures();
    releaseTransport();
    socket.close();
  };
}
