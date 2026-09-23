import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessGrepTool } from '../../../../../services/grepTool';

export default defineMcpTool(createHeadlessGrepTool);
