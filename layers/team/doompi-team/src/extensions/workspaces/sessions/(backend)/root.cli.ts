import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { createAgentStatus, registerSubagentLeaderContribution } from '../(frontend)/overlay/_lib/contributions';
import { createTeamRoot } from './_lib/root.cli';

const contribution = createTeamRoot({ createAgentStatus, registerSubagentLeaderContribution });

export default defineRoutedContribution(contribution, {});
