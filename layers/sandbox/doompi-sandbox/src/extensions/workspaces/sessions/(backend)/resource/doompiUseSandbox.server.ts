import { defineResource, defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { createSandboxSkillResource } from '../_lib/sandboxResources';
import type { SandboxServerScope } from '../_lib/sandboxScope';

export default defineRoutedContribution(
  defineResource((context: WithRoot<DoomServerPluginContext, SandboxServerScope>) =>
    createSandboxSkillResource(context.root),
  ),
  { cardinality: 'optional' },
);
