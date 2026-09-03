import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { PairingApprovalDialog } from '../features/remote/PairingApprovalDialog.tsx';
import { RemoteAccessDialog } from '../features/remote/RemoteAccessDialog.tsx';
import { RemoteBanner } from '../features/remote/RemoteBanner.tsx';
import { ThreadView } from '../features/session/ThreadView.tsx';
import { installWebPlugins, webPluginDiagnostics } from '../lib/pluginRegistry.ts';
import { startSessionWebPluginRuntime } from '../lib/pluginRuntime.ts';
import { bindThreadRenderer } from '../lib/threadRenderer.ts';
import { onHubConnected, sendFrame, sendHubFrame } from '../lib/transport.ts';
import { routeTree } from '../routes/routeTree.tsx';
import { restoreSealedSession } from '../lib/sealedSession.ts';
import { restoreLivePushRegistration } from '../lib/livePush.ts';
import { refreshRemoteState } from '../stores/remoteAccessStore.ts';
import { startSessionRuntime } from './sessionRuntime.ts';
import { webPlugins } from './webPlugins.generated.ts';

// Module scope: the registry is complete before the first render reads it.
// A collision between two installed plugins never blanks the page; it is
// resolved at install and reported here, once.
installWebPlugins(webPlugins);
for (const diagnostic of webPluginDiagnostics()) {
  console.warn(`web plugin '${diagnostic.pluginId}' ${diagnostic.kind}: ${diagnostic.message}`);
}
// The thread view a plugin panel renders through its props; bound here, where
// the feature and the props builder can both be seen.
bindThreadRenderer((sessionId, threadId, options) => (
  <ThreadView sessionId={sessionId} threadId={threadId} options={options} />
));

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Providers() {
  useEffect(() => {
    // The channel first: a socket opened before it is established would send
    // its first frames in the clear, and on loopback this resolves immediately
    // to no channel at all.
    let stopRuntime: (() => void) | undefined;
    let stopPlugins: (() => void) | undefined;
    let cancelled = false;
    void restoreSealedSession().then(() => {
      if (cancelled) return;
      stopPlugins = startSessionWebPluginRuntime({ sendSessionFrame: sendFrame, sendHubFrame, onHubConnected });
      stopRuntime = startSessionRuntime();
      // One read at start; after that the hub pushes state, so nothing polls.
      void refreshRemoteState();
      void restoreLivePushRegistration();
    });
    return () => {
      cancelled = true;
      stopPlugins?.();
      stopRuntime?.();
    };
  }, []);

  return (
    <TooltipProvider>
      {/* Mounted once at the root rather than per route: a banner that warns
          the tunnel is open must not be missable by navigating, and the
          approval prompt has to reach the host wherever they are. */}
      <RemoteBanner />
      <RemoteAccessDialog />
      <PairingApprovalDialog />
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
