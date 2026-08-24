import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { installWebPlugins, startWebPlugins } from '../lib/pluginRegistry.ts';
import { sendFrame, sendHubFrame } from '../lib/transport.ts';
import { routeTree } from '../routes/routeTree.tsx';
import { startSessionRuntime } from './sessionRuntime.ts';
import { webPlugins } from './webPlugins.generated.ts';

// Module scope: the registry is complete before the first render reads it.
installWebPlugins(webPlugins);

const router = createRouter({ routeTree });
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
