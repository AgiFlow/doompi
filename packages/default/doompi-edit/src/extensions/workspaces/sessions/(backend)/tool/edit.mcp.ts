import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createHeadlessEditTool } from '../../../../../services/editTool';

export default defineMcpTool(createHeadlessEditTool);
