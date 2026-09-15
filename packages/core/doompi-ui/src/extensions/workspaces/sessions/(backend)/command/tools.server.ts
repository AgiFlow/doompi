import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { createUiServerContributions } from '../_lib/sessionInventory';

export default defineRoutedContribution(createUiServerContributions().commands![0]!, {});
