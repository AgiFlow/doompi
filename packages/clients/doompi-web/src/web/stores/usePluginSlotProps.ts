import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { pluginSlotProps } from '../lib/pluginSlotProps.ts';
import { minorModes } from '../lib/composition.ts';
import { appendComposerDraft, attachComposerCapture, attachComposerContext } from './composerStore.ts';
import { sessionStoreFor } from './sessionStore.ts';
import { closeTransientTab, openTransientTab } from './transientTabsStore.ts';
import { useOpenTab } from './useOpenTab.ts';

/** The props a plugin component receives for a session, with the host's navigation and facts bound in. */
export function usePluginSlotProps(sessionId: string | null, onOpen?: () => void): WebPluginSlotProps {
  const statuses = useStore(sessionStoreFor(sessionId), (state) => state.statuses);
  const catalog = useStore(sessionStoreFor(sessionId), (state) => state.minorModes);
  const widgets = useStore(sessionStoreFor(sessionId), (state) => state.widgets);
  const contextInventory = useStore(
    sessionStoreFor(sessionId),
    (state) => state.context?.groups.flatMap((group) => group.items) ?? [],
  );
  const openTab = useOpenTab();
  const props = pluginSlotProps(
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
    (capture) => attachComposerCapture(sessionId, capture),
    contextInventory,
  );
  props.activeMinorModes = minorModes(statuses, widgets, catalog)
    .filter((mode) => mode.availability === 'on')
    .map((mode) => mode.name);
  return props;
}
