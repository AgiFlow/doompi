import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createComputerUseChannel } from '../../controllers/webComputerUseChannel';

export default (({ host }) =>
  host.scope === 'session' ? {} : { channels: [createComputerUseChannel] }) satisfies NonNullable<
  DoomServerPluginDefinition['global']
>;
