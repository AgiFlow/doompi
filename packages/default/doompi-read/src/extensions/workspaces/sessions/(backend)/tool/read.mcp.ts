import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createHeadlessReadTool } from '../../../../../services/readTool';

export default defineMcpTool(createHeadlessReadTool);
