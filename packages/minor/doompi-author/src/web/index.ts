import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { authorFileLinks } from './AuthorDocumentPanel.tsx';
import { startAuthorBrowserBridge } from './authorBrowserBridge.ts';
import { authorChannel } from './authorStore.ts';
import { DescribeAuthorToolsToolCard } from './DescribeAuthorToolsToolCard.tsx';
import { UseAuthorToolsToolCard } from './UseAuthorToolsToolCard.tsx';

/**
 * This package's cockpit presence: the named export the generated plugin
 * registry imports. Plugins are independent, so nothing here depends on
 * install order; every relation to another plugin resolves by name.
 */
export const webPlugin = defineWebPlugin({
  id: 'author',
  channels: [authorChannel],
  fileLinks: authorFileLinks,
  toolRenderers: [
    { tools: ['describe_author_tools'], message: DescribeAuthorToolsToolCard },
    { tools: ['use_author_tools'], message: UseAuthorToolsToolCard },
  ],
  start: startAuthorBrowserBridge,
});
