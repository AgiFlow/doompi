import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createSearchSkillsTool } from '../../../../../services/mcpSkillTools';

export default defineMcpTool(createSearchSkillsTool());
