import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { ReadToolMessage } from '../web/components/ReadToolMessage';

/**
 * This package's cockpit presence: the read tool's timeline card, the web
 * half of the TUI's renderCall and renderResult for hashline reads.
 */
export const webPlugin = defineWebPlugin({
  id: 'read',
  session: {
    toolRenderers: [{ tools: ['read'], message: ReadToolMessage }],
  },
});
