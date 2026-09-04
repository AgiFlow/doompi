import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { pluginSlotProps } from '../lib/pluginSlotProps.ts';
import { appendComposerDraft, attachComposerContext } from './composerStore.ts';
import { sessionStoreFor } from './sessionStore.ts';
import { closeTransientTab, openTransientTab } from './transientTabsStore.ts';
import { useOpenTab } from './useOpenTab.ts';

/** The props a plugin component receives for a session, with the host's navigation and facts bound in. */
export function usePluginSlotProps(sessionId: string | null, onOpen?: () => void): WebPluginSlotProps {
  const statuses = useStore(sessionStoreFor(sessionId), (state) => state.statuses);
  const openTab = useOpenTab();
  return pluginSlotProps(
    sessionId,
    (tabId) => {
      onOpen?.();
      openTab(tabId);
    },
    statuses,
    {
      open(tab) {
        if (sessionId === null) return;
        onOpen?.();
        openTransientTab(sessionId, tab);
        openTab(tab.id);
      },
      close(tabId) {
        if (sessionId !== null) closeTransientTab(sessionId, tabId);
      },
    },
    (text) => appendComposerDraft(sessionId, text),
    (item) => attachComposerContext(sessionId, item),
  );
}
