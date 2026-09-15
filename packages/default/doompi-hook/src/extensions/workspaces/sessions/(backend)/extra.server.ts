import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { hookResource, serverHooks } from '../../../../controllers/serverHooks';
export default { resources: [hookResource], hooks: serverHooks } satisfies NonNullable<
  DoomServerPluginDefinition['session']
>;
