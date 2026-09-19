import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createHeadlessGrepTool } from '../../../../../services/grepTool';

export default defineMcpTool(createHeadlessGrepTool);
