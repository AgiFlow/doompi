import { defineCliCommand } from '@agimon-ai/doompi-core/extensionFile';

import { openAgentCatalog } from '../../(frontend)/overlay/_lib/agent-catalog.cli';
import { buildAgentCatalogEntries } from '../../(frontend)/overlay/_lib/agentResourceProjection';
import { createAgentListContribution } from './_lib/subagents-list.cli';

export default defineCliCommand(
  createAgentListContribution({ buildEntries: buildAgentCatalogEntries, open: openAgentCatalog }),
);
