import { defineMcpSkill } from '@agimon-ai/doompi-core/mcp-facet';

import { REMOTE_TEAM_GUIDANCE } from '../../../../../constants/remoteTeam';

export default defineMcpSkill({
  name: 'doompi-team',
  description:
    'Understand the bound session Team capabilities and remote result-delivery limits before considering delegation.',
  read: () => REMOTE_TEAM_GUIDANCE,
});
