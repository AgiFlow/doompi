import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createAuthorChannel } from '../../../services/webAuthorChannel';

export default defineChannel(createAuthorChannel);
