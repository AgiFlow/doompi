import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';

export default defineRoot((_context: PiPluginContext) => ({
  value: undefined,
  services: [provideBackgroundWorkService],
}));
