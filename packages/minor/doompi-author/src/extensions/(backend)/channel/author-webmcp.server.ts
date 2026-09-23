import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import { createAuthorChannel } from '../../../services/webAuthorChannel';

export default defineChannel(createAuthorChannel);
