import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { createComputerUseChannel } from '../../../services/webComputerUseChannel';

export default (({ host }) =>
  host.scope === 'session' ? {} : { channels: [createComputerUseChannel] }) satisfies NonNullable<
  DoomServerPluginDefinition['global']
>;
