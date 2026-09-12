import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { useStore } from '@tanstack/react-store';
import { useCallback, useMemo } from 'react';
import { minorModes } from '../lib/composition';
import { pluginSlotProps } from '../lib/pluginSlotProps';
import { submitCapture } from './captureStore';
import { appendComposerDraft, attachComposerCapture, attachComposerContext } from './composerStore';
import { sessionStoreFor } from './sessionStore';
import { closeTransientTab, openTransientTab } from './transientTabsStore';
import { useOpenTab } from './useOpenTab';
import { useWebPluginRegistry } from './useWebPluginRegistry';
/** The props a plugin component receives for a session, with the host's navigation and facts bound in. */
export function usePluginSlotProps(sessionId: string | null, onOpen?: () => void): WebPluginSlotProps {
  const store = sessionStoreFor(sessionId);
  const statuses = useStore(store, (state) => state.statuses);
  const catalog = useStore(store, (state) => state.minorModes);
  const widgets = useStore(store, (state) => state.widgets);
  const context = useStore(store, (state) => state.context);
  const contextInventory = useMemo(() => context?.groups.flatMap((group) => group.items) ?? [], [context]);
  const openTab = useOpenTab();
  const registryRevision = useWebPluginRegistry();
  const openPluginTab = useCallback(
    (tabId: string | null) => {
      onOpen?.();
      openTab(tabId);
    },
    [onOpen, openTab],
  );
  const openPluginTransientTab = useCallback(
    (tab: Parameters<typeof openTransientTab>[1]) => {
      if (sessionId === null) return;
      onOpen?.();
      openTransientTab(sessionId, tab);
      openTab(tab.id);
    },
    [onOpen, openTab, sessionId],
  );
  const closePluginTransientTab = useCallback(
    (tabId: string) => {
      if (sessionId !== null) closeTransientTab(sessionId, tabId);
    },
    [sessionId],
  );
  const appendDraft = useCallback((text: string) => appendComposerDraft(sessionId, text), [sessionId]);
  const attachContext = useCallback(
    (item: Parameters<typeof attachComposerContext>[1]) => attachComposerContext(sessionId, item),
    [sessionId],
  );
  const attachCapture = useCallback(
    (capture: Parameters<typeof attachComposerCapture>[1]) => attachComposerCapture(sessionId, capture),
    [sessionId],
  );
  const capture = useCallback(
    (value: Parameters<typeof submitCapture>[1]) => submitCapture(sessionId, value),
    [sessionId],
  );
  const activeMinorModes = useMemo(
    () =>
      minorModes(statuses, widgets, catalog)
        .filter((mode) => mode.availability === 'on')
        .map((mode) => mode.name),
    [catalog, statuses, widgets],
  );

  return useMemo(() => {
    void registryRevision;
    const props = pluginSlotProps(
      sessionId,
      openPluginTab,
      statuses,
      { open: openPluginTransientTab, close: closePluginTransientTab },
      appendDraft,
      attachContext,
      attachCapture,
      contextInventory,
      capture,
    );
    props.activeMinorModes = activeMinorModes;
    return props;
  }, [
    activeMinorModes,
    appendDraft,
    attachCapture,
    attachContext,
    capture,
    closePluginTransientTab,
    contextInventory,
    openPluginTab,
    openPluginTransientTab,
    registryRevision,
    sessionId,
    statuses,
  ]);
}
