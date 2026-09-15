import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createDomainServerCommand } from '../../../../controllers/domainServerCommand';
import { domainServerResources } from '../../../../controllers/domainServerResources';
import { readPackageResource } from '../../../../services/packageResources';

type HeadlessExecution = NonNullable<DoomServerPluginContext['agent']>['context'];

export default async ({ agent }: DoomServerPluginContext) => ({
  commands: agent ? [createDomainServerCommand(agent)] : [],
  resources: [
    ...(agent ? await domainServerResources(agent.context) : []),
    {
      name: 'doompi/domain-config',
      kind: 'context' as const,
      read: (execution: HeadlessExecution) => JSON.stringify({ domains: execution.selection.domains }),
    },
    {
      name: 'doompi-author-domain',
      kind: 'skill' as const,
      read: () => readPackageResource('src/prompts/doompi-author-domain/SKILL.md'),
    },
  ],
});
