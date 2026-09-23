import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { createLoadContextTool } from '../../../../../services/mcpContextTools';

export default defineMcpTool((context: DoomMcpPluginContext) => createLoadContextTool(context));
