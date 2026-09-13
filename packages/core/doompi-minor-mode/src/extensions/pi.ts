import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createMinorModePiRuntime } from '../controllers/catalogRuntime';
export default definePiExtension('@agimon-ai/doompi-minor-mode', ({ pi }) => createMinorModePiRuntime(pi));
