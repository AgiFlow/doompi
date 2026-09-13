import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

import { TasksActivitySection } from '../web/components/TasksActivitySection';
import { TaskToolMessage } from '../web/components/TaskToolMessage';
import { tasksChannel } from '../web/stores/tasksStore';

/**
 * This package's cockpit presence: the live session task graph in the activity
 * dock and the task tool's timeline card.
 */
export const webPlugin = defineWebPlugin({
  id: 'task',
  session: {
    channels: [tasksChannel],
    activitySections: [{ id: 'tasks', component: TasksActivitySection }],
    toolRenderers: [{ tools: ['task'], message: TaskToolMessage }],
  },
});
