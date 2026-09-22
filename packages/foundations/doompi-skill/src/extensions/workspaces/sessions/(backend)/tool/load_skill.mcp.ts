import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createLoadSkillTool } from '../../../../../services/mcpSkillTools';

export default defineMcpTool(createLoadSkillTool());
