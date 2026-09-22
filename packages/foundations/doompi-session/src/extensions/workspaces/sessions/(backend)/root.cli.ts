import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';

export default defineRoot((_context: PiPluginContext) => ({
  value: undefined,
  services: [provideBackgroundWorkService],
}));
