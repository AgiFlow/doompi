import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createComputerUseChannel } from '../../../services/webComputerUseChannel';

export default defineChannel(createComputerUseChannel);
