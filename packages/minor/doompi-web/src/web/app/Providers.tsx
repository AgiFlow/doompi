import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { installWebPlugins, startWebPlugins, webPluginDiagnostics } from '../lib/pluginRegistry.ts';
import { sendFrame, sendHubFrame } from '../lib/transport.ts';
import { routeTree } from '../routes/routeTree.tsx';
import { startSessionRuntime } from './sessionRuntime.ts';
import { webPlugins } from './webPlugins.generated.ts';

// Module scope: the registry is complete before the first render reads it.
// A collision between two installed plugins never blanks the page; it is
// resolved at install and reported here, once.
installWebPlugins(webPlugins);
for (const diagnostic of webPluginDiagnostics()) {
  console.warn(`web plugin '${diagnostic.pluginId}' ${diagnostic.kind}: ${diagnostic.message}`);
}

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Providers() {
  useEffect(() => {
    const stopRuntime = startSessionRuntime();
    const stopPlugins = startWebPlugins({ sendSessionFrame: sendFrame, sendHubFrame });
    return () => {
      stopPlugins();
      stopRuntime();
    };
  }, []);

  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
