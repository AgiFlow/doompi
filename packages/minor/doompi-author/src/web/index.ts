import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { AuthorPanel } from './AuthorPanel.tsx';
import { authorFileLinks } from './AuthorDocumentPanel.tsx';
import { startAuthorBrowserBridge } from './authorBrowserBridge.ts';
import { author, authorChannel } from './authorStore.ts';
import { DescribeAuthorToolsToolCard } from './DescribeAuthorToolsToolCard.tsx';
import { UseAuthorToolsToolCard } from './UseAuthorToolsToolCard.tsx';
export function useAuthorBadge(sessionId: string | null): number {
  return useStore(author.store, (state) => author.select(state, sessionId).capabilityCount);
}

/**
 * This package's cockpit presence: the named export the generated plugin
 * registry imports. Plugins are independent, so nothing here depends on
 * install order; every relation to another plugin resolves by name.
 */
export const webPlugin = defineWebPlugin({
  id: 'author',
  tabs: [
    {
      id: 'author',
      label: 'author',
      panel: AuthorPanel,
      retainComposer: true,
      useBadge: useAuthorBadge,
    },
  ],
  channels: [authorChannel],
  fileLinks: authorFileLinks,
  toolRenderers: [
    { tools: ['describe_author_tools'], message: DescribeAuthorToolsToolCard },
    { tools: ['use_author_tools'], message: UseAuthorToolsToolCard },
  ],
  start: startAuthorBrowserBridge,
});
