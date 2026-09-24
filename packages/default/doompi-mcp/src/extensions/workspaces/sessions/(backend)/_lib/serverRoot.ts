import { DOOM_CHILD_SESSION_MCP_TOOL_SERVICE } from '@agimon-ai/doompi-core/childSession';
import type { Context } from '@deepseek-ai/cordis';

import { mountMcpHeadlessTools } from '../../../../../services/mcpHeadlessTools';
import { createMcpServerRuntime } from '../../../../../services/serverRuntime';
export const createMcpServerRoot = () => {
  const runtime = createMcpServerRuntime();
  return {
    value: runtime,
    activities: runtime.activities,
    services: [
      mountMcpHeadlessTools(runtime.tools),
      (context: Context) => {
        context.provide(DOOM_CHILD_SESSION_MCP_TOOL_SERVICE, runtime.childTool);
      },
    ],
  };
};
export type McpServerScope = Awaited<ReturnType<typeof createMcpServerRoot>>['value'];
