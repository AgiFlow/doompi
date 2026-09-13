import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect } from 'react';

import { PairingApprovalDialog } from '../features/remote/PairingApprovalDialog';
import { RemoteAccessDialog } from '../features/remote/RemoteAccessDialog';
import { ThreadView } from '../features/session/ThreadView';
import { onComposerSubmitted } from '../lib/composerSubmissions';
import { restoreLivePushRegistration } from '../lib/livePush';
import { acquireModelContext, disposeModelContextAdapter } from '../lib/modelContextAdapter';
import { installWebPlugins, webPluginDiagnostics, webPluginsInstalled } from '../lib/pluginRegistry';
import { startSessionWebPluginRuntime } from '../lib/pluginRuntime';
import { restoreSealedSession } from '../lib/sealedSession';
import { bindThreadRenderer } from '../lib/threadRenderer';
import { invokeServerMethod, onHubConnected, sendFrame, sendHubFrame } from '../lib/transport';
import { routeTree } from '../routes/routeTree';
import { onCaptureStatus } from '../stores/captureStore';
import { refreshRemoteState, remoteAccessStore } from '../stores/remoteAccessStore';
import { startSessionRuntime } from './sessionRuntime';
import { webPlugins } from './webPlugins.generated';

// Module scope: the registry is complete before the first render reads it.
// A collision between two installed plugins never blanks the page; it is
// resolved at install and reported here, once.
// Vite re-evaluates this module during development without replacing the
// registry module. Keep its live session and workspace mounts intact.
if (!webPluginsInstalled()) installWebPlugins(webPlugins);
for (const diagnostic of webPluginDiagnostics()) {
  console.warn(`web plugin '${diagnostic.pluginId}' ${diagnostic.kind}: ${diagnostic.message}`);
}
// The thread view a plugin panel renders through its props; bound here, where
// the feature and the props builder can both be seen.
bindThreadRenderer((sessionId, threadId, options) => (
  <ThreadView sessionId={sessionId} threadId={threadId} options={options} />
));

const router = createRouter({ routeTree });
const PAIRING_STATE_POLL_MS = 1000;

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Providers() {
  const remoteStatus = useStore(remoteAccessStore, (state) => state.view?.status);

  useEffect(() => {
    // The channel first: a socket opened before it is established would send
    // its first frames in the clear, and on loopback this resolves immediately
    // to no channel at all.
    let stopRuntime: (() => void) | undefined;
    let stopPlugins: (() => void) | undefined;
    let cancelled = false;
    void restoreSealedSession().then(() => {
      if (cancelled) return;
      stopPlugins = startSessionWebPluginRuntime({
        sendSessionFrame: sendFrame,
        sendHubFrame,
        invokeServerMethod,
        onHubConnected,
        acquireModelContext,
        onComposerSubmitted,
        onCaptureStatus,
      });
      stopRuntime = startSessionRuntime();
      // Read initial state; the loopback host checks for pairing requests below.
      void refreshRemoteState();
      void restoreLivePushRegistration();
    });
    return () => {
      cancelled = true;
      stopPlugins?.();
      stopRuntime?.();
      disposeModelContextAdapter();
    };
  }, []);

  useEffect(() => {
    // The process-local remote runtime does not yet bridge its host-only pairing
    // event into the hub socket. Only the loopback host needs this pending queue.
    if (remoteStatus !== 'on' || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void refreshRemoteState().finally(() => {
        fetching = false;
      });
    }, PAIRING_STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [remoteStatus]);

  return (
    <TooltipProvider>
      {/* Mounted once at the root so the approval prompt reaches the host wherever they are. */}
      <RemoteAccessDialog />
      <PairingApprovalDialog />
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
