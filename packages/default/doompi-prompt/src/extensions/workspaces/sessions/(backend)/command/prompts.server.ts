import { defineServerCommand } from '@agimon-ai/doompi-core/extension-file';

import { serverPromptCommand } from '../../../../../services/serverPrompts';
export default defineServerCommand(serverPromptCommand);
