import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { createMcpWriteTool } from '../_lib/mcpFileTools';

export default defineMcpTool<DoomHeadlessTool['parameters'], DoomMcpPluginContext>(createMcpWriteTool);
