import type { DoomServerPluginDefinition } from '@agimon-ai/doompi-core/server-facet';

import { autocompactResource, autocompactActivity } from '../../../../controllers/serverAutocompact';

export default {
  resources: [autocompactResource],
  activities: [autocompactActivity],
} satisfies NonNullable<DoomServerPluginDefinition['session']>;
