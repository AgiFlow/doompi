import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createSearchSkillsTool } from '../../../../../services/mcpSkillTools';

export default defineMcpTool(createSearchSkillsTool());
