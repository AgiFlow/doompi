import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { createDomainServerCommand } from '../controllers/domainServerCommand';
import { readPackageResource } from '../services/packageResources';
import { DOMAIN_SOURCE } from '../types/domains';

export const domainServerFacet = defineServerPlugin({
  name: DOMAIN_SOURCE,
  session: ({ agent }) => ({
    commands: agent ? [createDomainServerCommand(agent)] : [],
    resources: [
      {
        name: 'doompi/domain-config',
        kind: 'context',
        read: (execution) => JSON.stringify({ domains: execution.selection.domains }),
      },
      {
        name: 'doompi-author-domain',
        kind: 'skill',
        read: () => readPackageResource('src/prompts/doompi-author-domain/SKILL.md'),
      },
    ],
  }),
});
export default domainServerFacet;
