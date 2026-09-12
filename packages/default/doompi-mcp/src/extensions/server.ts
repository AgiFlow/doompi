import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { mcpHubApi } from '../controllers/mcpHubApi';
import { createMcpServerRuntime } from '../controllers/serverRuntime';
export const mcpServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-mcp',
  global: { api: [mcpHubApi] },
  workspace: { api: [mcpHubApi] },
  session: () => createMcpServerRuntime(),
});
export default mcpServerFacet;
