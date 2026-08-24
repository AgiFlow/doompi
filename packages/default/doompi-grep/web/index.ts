import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { GrepToolCall, GrepToolResult } from './GrepToolCard.tsx';

/**
 * This package's cockpit presence: the grep tool's timeline card, the web
 * half of the TUI's renderCall and renderResult for hashline searches.
 */
export const webPlugin = defineWebPlugin({
  id: 'grep',
  toolRenderers: [{ tools: ['grep'], call: GrepToolCall, result: GrepToolResult }],
});
