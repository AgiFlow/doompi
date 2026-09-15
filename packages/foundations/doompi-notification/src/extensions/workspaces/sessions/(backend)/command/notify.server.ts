import { defineServerCommand } from '@agimon-ai/doompi-core/extension-file';

import { notificationCommand } from '../_lib/notificationCommand';

export default defineServerCommand(notificationCommand);
