import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { api } from '../../../../../services/computerUseApi';
import { createComputerUseServer } from '../../../../../services/computerUseServer';

export default (({ agent }) => ({
  ...(agent ? createComputerUseServer(agent) : {}),
  api: [api],
})) satisfies NonNullable<DoomServerPluginDefinition['session']>;
