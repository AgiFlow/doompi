import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createMinorModePiRuntime } from './_lib/catalogRuntime';

export default ({ pi }: PiPluginContext) => createMinorModePiRuntime(pi);
