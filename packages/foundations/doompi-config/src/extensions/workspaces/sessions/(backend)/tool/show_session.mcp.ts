import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { createShowSessionTool } from '../../../../../services/mcpContextTools';

export default defineMcpTool((context: DoomMcpPluginContext) => createShowSessionTool(context));
