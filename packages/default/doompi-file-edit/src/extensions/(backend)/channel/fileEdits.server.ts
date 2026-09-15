import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHubChannel } from '@agimon-ai/doompi-core/hub-channel';

import { createFilesChannel } from '../../../services/webFilesChannel';
export default defineRoutedContribution(function fileEditsChannel(): DoomHubChannel {
  return createFilesChannel();
}, {});
