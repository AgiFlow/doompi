import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createAskUserHeadlessTool } from '../_tools/askUserHeadless';

export default defineMcpTool(createAskUserHeadlessTool());
