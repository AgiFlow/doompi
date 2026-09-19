import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';

import { REMOTE_TEAM_GUIDANCE } from '../../../../../constants/remoteTeam';

export default defineMcpSkill({
  name: 'doompi-team',
  description: 'Coordinate persistent subagents and active team members through the explicit remote Team tools.',
  read: () => REMOTE_TEAM_GUIDANCE,
});
