import { Button, TooltipProvider } from '@agimon-ai/doompi-web-components';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useState } from 'react';

import { PairingApprovalDialog } from '../features/remote/PairingApprovalDialog';
import { RemoteAccessDialog } from '../features/remote/RemoteAccessDialog';
import { SessionActivity } from '../features/session/SessionActivity';
import { SessionTranscriptView } from '../features/session/SessionTranscriptView';
import { ThreadView } from '../features/session/ThreadView';
import { onComposerSubmitted } from '../lib/composerSubmissions';
import { restoreLivePushRegistration } from '../lib/livePush';
import { acquireModelContext, disposeModelContextAdapter } from '../lib/modelContextAdapter';
import { installWebPlugins, webPluginDiagnostics, webPluginsInstalled } from '../lib/pluginRegistry';
import { startSessionWebPluginRuntime } from '../lib/pluginRuntime';
import { restoreSealedSession } from '../lib/sealedSession';
import { bindSessionActivityRenderer } from '../lib/sessionActivityRenderer';
import { bindSessionTranscriptRenderer } from '../lib/sessionTranscriptRenderer';
import { bindThreadRenderer } from '../lib/threadRenderer';
import { invokeServerMethod, onHubConnected, sendFrame, sendHubFrame } from '../lib/transport';
import { routeTree } from '../routes/routeTree';
import { onCaptureStatus } from '../stores/captureStore';
import { refreshRemoteState, remoteAccessStore } from '../stores/remoteAccessStore';
import { startSessionRuntime } from './sessionRuntime';
import { watchSessionTranscript } from './sessionTranscriptWatch';
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
bindSessionActivityRenderer((sessionId, onOpenConversation) => (
  <SessionActivity sessionId={sessionId} onOpenConversation={onOpenConversation} />
));
bindSessionTranscriptRenderer((sessionId, options) => (
  <SessionTranscriptView sessionId={sessionId} options={options} watch={watchSessionTranscript} />
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
  const [connection, setConnection] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    // Restore before mounting any API consumers, not just before opening sockets.
    let stopRuntime: (() => void) | undefined;
    let stopPlugins: (() => void) | undefined;
    let cancelled = false;
    const stop = () => {
      stopPlugins?.();
      stopPlugins = undefined;
      stopRuntime?.();
      stopRuntime = undefined;
      disposeModelContextAdapter();
    };
    void restoreSealedSession()
      .then((restored) => {
        if (cancelled) return;
        if (!restored && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
          setConnection('error');
          return;
        }
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
        setConnection('ready');
        // Read initial state; the loopback host checks for pairing requests below.
        void refreshRemoteState();
        void restoreLivePushRegistration();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        stop();
        console.error('Cockpit connection failed.', error);
        setConnection('error');
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    // The process-local remote runtime does not yet bridge its host-only pairing
    // event into the hub socket. Only the loopback host needs this pending queue.
    if (
      connection !== 'ready' ||
      remoteStatus !== 'on' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    )
      return;
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void refreshRemoteState().finally(() => {
        fetching = false;
      });
    }, PAIRING_STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [connection, remoteStatus]);

  if (connection !== 'ready') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-doom-bg p-5 text-base text-doom-text">
        {connection === 'loading' ? (
          <p role="status" data-testid="connection-loading" className="text-doom-dim">
            Connecting to DoomPi…
          </p>
        ) : (
          <>
            <p role="alert" data-testid="connection-error">
              Could not establish a connection to DoomPi. Reload or sign in again.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Button variant="outline" onClick={() => location.reload()}>
                Reload
              </Button>
              <a href="/pair" className="text-doom-blue underline">
                Sign in or pair again
              </a>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider>
      {/* Mounted once at the root so the approval prompt reaches the host wherever they are. */}
      <RemoteAccessDialog />
      <PairingApprovalDialog />
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
