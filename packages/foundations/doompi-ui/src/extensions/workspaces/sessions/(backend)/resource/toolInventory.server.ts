import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { createUiServerContributions } from '../_lib/sessionInventory';
export default defineResource(createUiServerContributions().resources![0]!);
