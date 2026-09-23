import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHubChannel } from '@agimon-ai/doompi-core/hubChannel';

import { createRunnersChannel } from '../../../services/runnersChannel';
export default defineChannel(function runnerRunsChannel(): DoomHubChannel {
  return createRunnersChannel();
});
