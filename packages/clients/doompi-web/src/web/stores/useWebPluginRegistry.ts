import { useSyncExternalStore } from 'react';

import { subscribeWebPluginRegistry, webPluginRegistryRevision } from '../lib/pluginRegistry';

/** Re-renders a host surface when the focused session's plugin composition changes. */
export function useWebPluginRegistry(): number {
  return useSyncExternalStore(subscribeWebPluginRegistry, webPluginRegistryRevision, webPluginRegistryRevision);
}
