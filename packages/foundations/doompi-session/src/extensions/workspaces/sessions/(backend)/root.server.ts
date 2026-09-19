import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';

export default defineRoot((_context: DoomServerPluginContext) => ({
  value: undefined,
  services: [provideBackgroundWorkService],
}));
