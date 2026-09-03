import { useSyncExternalStore } from 'react';
import { subscribeWebPluginRegistry, webPluginRegistryRevision } from '../lib/pluginRegistry.ts';

/** Re-renders a host surface when the focused session's plugin composition changes. */
export function useWebPluginRegistry(): void {
  useSyncExternalStore(subscribeWebPluginRegistry, webPluginRegistryRevision, webPluginRegistryRevision);
}
