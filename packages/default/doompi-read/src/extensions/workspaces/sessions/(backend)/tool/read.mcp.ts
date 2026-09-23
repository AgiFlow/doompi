import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessReadTool } from '../../../../../services/readTool';

export default defineMcpTool(createHeadlessReadTool);
