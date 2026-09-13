import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

import { GrepToolMessage } from '../web/components/GrepToolMessage';

/**
 * This package's cockpit presence: the grep tool's timeline card, the web
 * half of the TUI's renderCall and renderResult for hashline searches.
 */
export const webPlugin = defineWebPlugin({
  id: 'grep',
  session: {
    toolRenderers: [{ tools: ['grep'], message: GrepToolMessage }],
  },
});
