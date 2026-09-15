import { defineServerCommand } from '@agimon-ai/doompi-core/extension-file';

import contribution from './_lib/tasks.server';

export default defineServerCommand(contribution);
