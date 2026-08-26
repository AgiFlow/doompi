import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { pluginSlotProps } from '../lib/pluginSlotProps.ts';
import { sessionStoreFor } from './sessionStore.ts';
import { closeTransientTab, openTransientTab } from './transientTabsStore.ts';
import { useOpenTab } from './useOpenTab.ts';

/** The props a plugin component receives for a session, with the host's navigation and facts bound in. */
export function usePluginSlotProps(sessionId: string | null): WebPluginSlotProps {
  const statuses = useStore(sessionStoreFor(sessionId), (state) => state.statuses);
  const openTab = useOpenTab();
  return pluginSlotProps(sessionId, openTab, statuses, {
    open(tab) {
      if (sessionId === null) return;
      openTransientTab(sessionId, tab);
      openTab(tab.id);
    },
    close(tabId) {
      if (sessionId !== null) closeTransientTab(sessionId, tabId);
    },
  });
}
