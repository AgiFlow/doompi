import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type { McpServerScope } from '../_lib/serverRoot';

export default defineRoutedContribution((context: WithRoot<unknown, McpServerScope>) => context.root.appMethods, {
  cardinality: 'many',
});
