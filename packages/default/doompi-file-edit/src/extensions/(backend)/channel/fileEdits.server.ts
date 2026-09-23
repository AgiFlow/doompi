import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHubChannel } from '@agimon-ai/doompi-core/hubChannel';

import { createFilesChannel } from '../../../services/webFilesChannel';
export default defineChannel(function fileEditsChannel(): DoomHubChannel {
  return createFilesChannel();
});
