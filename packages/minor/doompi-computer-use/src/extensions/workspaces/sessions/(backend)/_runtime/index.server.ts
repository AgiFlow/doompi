import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/serverFacet';

import { createComputerUseServer } from '../../../../../services/computerUseServer';

export default (({ agent, host }) =>
  agent ? createComputerUseServer(agent, host.context) : { tools: [], commands: [] }) satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
