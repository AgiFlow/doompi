import { defineMcpTool } from '@agimon-ai/doompi-core/mcp-facet';

import { createMcpServerRuntime } from '../../../../../services/serverRuntime';

export default defineMcpTool(() => createMcpServerRuntime().tools[0]!);
