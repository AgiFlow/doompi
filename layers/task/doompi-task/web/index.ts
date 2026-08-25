import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { TaskToolMessage } from './TaskToolMessage.tsx';

/**
 * This package's cockpit presence: the task tool's timeline card, the web
 * half of src/tui/format.ts (renderTaskCall and renderTaskResult).
 */
export const webPlugin = defineWebPlugin({
  id: 'task',
  toolRenderers: [{ tools: ['task'], message: TaskToolMessage }],
});
