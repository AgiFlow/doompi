import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { sessionAppUri } from '../../../../../../generated/mcp-apps/session';
import { createShowSessionTool } from '../../../../../services/mcpContextTools';

export default defineMcpTool((context: DoomMcpPluginContext) => createShowSessionTool(context, sessionAppUri));
