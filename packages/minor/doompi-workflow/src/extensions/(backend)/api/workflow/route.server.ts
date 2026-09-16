import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import legacy from '../../_lib/index.server';

export default defineRoutedContribution((context: Parameters<typeof legacy>[0]) => legacy(context).api?.[0], {
  cardinality: 'optional',
});
