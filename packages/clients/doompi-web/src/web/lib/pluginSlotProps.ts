import type {
  SlotDataFill,
  SlotDeclaration,
  TransientTab,
  WebPluginContextItem,
  WebPluginSlotProps,
} from '@agimon-ai/doompi-web-contracts';
import { createElement, type ReactNode } from 'react';
import { fileTabForPath } from './composition.ts';
import { pluginContextActions, slotFills } from './pluginRegistry.ts';
import { renderThread } from './threadRenderer.ts';
import { sendFrame } from './transport.ts';

/** The host's hold on the focused session's runtime tabs, bound in by the caller that owns the store. */
export interface TransientTabActions {
  open: (tab: TransientTab) => void;
  close: (tabId: string) => void;
}

/**
 * The one place the props every plugin component receives are built. The
 * same object is handed to every fill a slot renders, so a fill that is
 * itself a slot owner can render its own slots with it.
 */
export function pluginSlotProps(
  sessionId: string | null,
  openTab: (tabId: string | null) => void,
  statuses: Readonly<Record<string, string>>,
  tabs: TransientTabActions,
  appendComposerDraft: (text: string) => void,
  attachComposerContext: (item: WebPluginContextItem) => void,
): WebPluginSlotProps {
  const props: WebPluginSlotProps = {
    sessionId,
    openTab,
    openTransientTab: tabs.open,
    closeTransientTab: tabs.close,
    // Asked per render rather than bound to a snapshot: which plugin claims a
    // path is a property of what is installed, and the answer is cheap.
    fileTabFor: (path) => fileTabForPath(sessionId, path),
    appendComposerDraft,
    attachComposerContext,
    contextActionsFor(item) {
      return pluginContextActions().flatMap((action) =>
        action.kinds.includes(item.kind)
          ? [
              {
                id: `${action.pluginId}.${action.id}`,
                label: action.label,
                ...(action.detail === undefined ? {} : { detail: action.detail }),
                run: () =>
                  action.run({
                    item,
                    sessionId,
                    openTab,
                    openTransientTab: tabs.open,
                    sendSessionFrame: sendFrame,
                  }),
              },
            ]
          : [],
      );
    },
    sendSessionFrame: sendFrame,
    statuses,
    renderThread(threadId, options): ReactNode {
      return sessionId === null ? null : renderThread(sessionId, threadId, options);
    },
    renderSlot(slot): ReactNode {
      return slotFills(slot).flatMap((fill) =>
        fill.component === undefined
          ? []
          : [createElement(fill.component, { ...props, key: `${fill.pluginId}:${fill.id}` })],
      );
    },
    slotData<Data>(declaration: SlotDeclaration<Data>): readonly SlotDataFill<Data>[] {
      return slotFills(declaration.slot).flatMap((fill) =>
        fill.data === undefined
          ? []
          : [{ pluginId: fill.pluginId, id: fill.id, order: fill.order, data: fill.data as Data }],
      );
    },
  };
  return props;
}
