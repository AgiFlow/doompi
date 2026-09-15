import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createFilesChannel } from '../../../controllers/webFilesChannel';
export default defineChannel(createFilesChannel);
