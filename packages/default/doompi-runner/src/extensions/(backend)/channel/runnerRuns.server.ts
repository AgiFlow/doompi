import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHubChannel } from '@agimon-ai/doompi-core/hub-channel';

import { createRunnersChannel } from '../../../services/runnersChannel';
export default defineRoutedContribution(function runnerRunsChannel(): DoomHubChannel {
  return createRunnersChannel();
}, {});
