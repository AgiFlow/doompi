import { defineServerCommand } from '@agimon-ai/doompi-core/extension-file';

import { createUiServerContributions } from '../_lib/sessionInventory';

export default defineServerCommand(createUiServerContributions().commands![0]!);
