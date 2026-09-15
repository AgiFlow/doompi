import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { modelGuidanceEvents } from '../../../../../controllers/modelGuidanceEvents';

export default (_context: PiPluginContext) =>
  (...args: Parameters<typeof modelGuidanceEvents.before_agent_start>) =>
    modelGuidanceEvents.before_agent_start(...args);
