import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { openSubagentFleet } from '../../(frontend)/overlay/_lib/fleet.cli';
import { createFleetContribution } from './_lib/subagents-fleet.cli';

export default defineRoutedContribution(createFleetContribution(openSubagentFleet), {});
