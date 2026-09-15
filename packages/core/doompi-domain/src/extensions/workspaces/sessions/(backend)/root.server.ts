import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { domainServerResources } from './_lib/domainServerResources';
import type { DomainServerScope } from './_lib/serverScope';

export default defineRoot(async ({ agent }: DoomServerPluginContext) => ({
  value: {
    resources: agent ? await domainServerResources(agent.context) : [],
  } satisfies DomainServerScope,
}));
