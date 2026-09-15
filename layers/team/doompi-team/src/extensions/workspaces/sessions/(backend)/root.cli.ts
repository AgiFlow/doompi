import { defineRoot } from '@agimon-ai/doompi-core/extension-file';

import { createAgentStatus, registerSubagentLeaderContribution } from '../(frontend)/overlay/_lib/contributions';
import { createTeamRoot } from './_lib/root.cli';

export default defineRoot(createTeamRoot({ createAgentStatus, registerSubagentLeaderContribution }));
