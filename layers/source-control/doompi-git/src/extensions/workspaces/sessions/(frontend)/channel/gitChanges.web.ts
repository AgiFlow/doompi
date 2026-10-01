import { defineChannelFile } from '@agimon-ai/doompi-core/web';

import { gitChangesChannel } from '../_lib/gitChangesStore';

export default defineChannelFile(gitChangesChannel);
