import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { EditToolMessage } from './EditToolMessage.tsx';

/**
 * This package's cockpit presence: the edit tool's timeline card, the web
 * half of the TUI's renderCall and renderResult for hashline edits.
 */
export const webPlugin = defineWebPlugin({
  id: 'edit',
  toolRenderers: [{ tools: ['edit'], message: EditToolMessage }],
});
