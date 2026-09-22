import { defineCliCommand } from '@agimon-ai/doompi-core/extensionFile';

import { openSubagentFleet } from '../../(frontend)/overlay/_lib/fleet.cli';
import { createFleetContribution } from './_lib/subagents-fleet.cli';

export default defineCliCommand(createFleetContribution(openSubagentFleet));
