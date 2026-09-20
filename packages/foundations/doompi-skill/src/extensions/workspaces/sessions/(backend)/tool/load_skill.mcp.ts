import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createLoadSkillTool } from '../../../../../services/mcpSkillTools';

export default defineMcpTool(createLoadSkillTool());
