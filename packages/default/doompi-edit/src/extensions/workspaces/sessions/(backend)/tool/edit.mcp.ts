import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessEditTool } from '../../../../../services/editTool';

export default defineMcpTool(createHeadlessEditTool);
