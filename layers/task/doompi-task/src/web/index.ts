import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { TasksActivitySection } from './TasksActivitySection.tsx';
import { TaskToolMessage } from './TaskToolMessage.tsx';
import { tasksChannel } from './tasksStore.ts';

/**
 * This package's cockpit presence: the live session task graph in the activity
 * dock and the task tool's timeline card.
 */
export const webPlugin = defineWebPlugin({
  id: 'task',
  channels: [tasksChannel],
  activitySections: [{ id: 'tasks', component: TasksActivitySection }],
  toolRenderers: [{ tools: ['task'], message: TaskToolMessage }],
});
