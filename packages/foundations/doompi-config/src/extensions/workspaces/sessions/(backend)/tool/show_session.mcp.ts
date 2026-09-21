import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';

import { sessionAppUri } from '../../../../../../generated/mcp-apps/session';
import { createShowSessionTool } from '../../../../../services/mcpContextTools';

export default defineMcpTool((context: DoomMcpPluginContext) => createShowSessionTool(context, sessionAppUri));
