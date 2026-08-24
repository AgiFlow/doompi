import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { ReadToolCall, ReadToolResult } from './ReadToolCard.tsx';

/**
 * This package's cockpit presence: the read tool's timeline card, the web
 * half of the TUI's renderCall and renderResult for hashline reads.
 */
export const webPlugin = defineWebPlugin({
  id: 'read',
  toolRenderers: [{ tools: ['read'], call: ReadToolCall, result: ReadToolResult }],
});
