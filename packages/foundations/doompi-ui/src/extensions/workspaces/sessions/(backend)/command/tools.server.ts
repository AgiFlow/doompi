import { defineServerCommand } from '@agimon-ai/doompi-core/extensionFile';

import { createUiServerContributions } from '../_lib/sessionInventory';

export default defineServerCommand(createUiServerContributions().commands![0]!);
