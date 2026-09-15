import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { openTaskSpace } from '../../(frontend)/overlay/_lib/task-space.cli';
import { createTasksContribution } from './_lib/tasks.cli';

export default defineRoutedContribution(createTasksContribution(openTaskSpace), {});
