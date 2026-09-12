import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { modelGuidanceEvents } from '../controllers/modelGuidanceEvents';

export const activateModelGuidanceExtension = definePiExtension({
  name: '@agimon-ai/doompi-model-guidance',
  events: modelGuidanceEvents,
});
export default activateModelGuidanceExtension;
