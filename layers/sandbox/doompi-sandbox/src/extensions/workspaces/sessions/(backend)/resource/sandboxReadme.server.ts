import { defineResource, defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createSandboxReadmeResource } from '../_lib/sandboxResources';
import type { SandboxServerScope } from '../_lib/sandboxScope';

export default defineRoutedContribution(
  defineResource((context: WithRoot<DoomServerPluginContext, SandboxServerScope>) =>
    createSandboxReadmeResource(context.root),
  ),
  { cardinality: 'optional' },
);
