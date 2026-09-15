import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { openAgentCatalog } from '../../(frontend)/overlay/_lib/agent-catalog.cli';
import { buildAgentCatalogEntries } from '../../(frontend)/overlay/_lib/agentResourceProjection';
import { createAgentListContribution } from './_lib/subagents-list.cli';

export default defineRoutedContribution(
  createAgentListContribution({ buildEntries: buildAgentCatalogEntries, open: openAgentCatalog }),
  {},
);
