import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { domainServerResources } from './_lib/domainServerResources';
import type { DomainServerScope } from './_lib/serverScope';

export default defineRoot(async ({ agent }: DoomServerPluginContext) => ({
  value: {
    resources: agent ? await domainServerResources(agent.context) : [],
  } satisfies DomainServerScope,
}));
