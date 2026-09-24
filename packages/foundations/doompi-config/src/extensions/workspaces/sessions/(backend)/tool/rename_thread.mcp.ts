import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { createRenameThreadTool } from '../../../../../services/mcpContextTools';

export default defineMcpTool((context: DoomMcpPluginContext) => createRenameThreadTool(context));
