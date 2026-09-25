import { DOOM_CHILD_SESSION_MCP_TOOL_SERVICE } from '@agimon-ai/doompi-core/childSession';
import { DOOM_HEADLESS_HOST_SERVICE, type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { DOOM_MCP_STATUS_SERVICE, type DoomMcpStatusService } from '@agimon-ai/doompi-core/mcpStatus';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  type DoomMcpToolResolverService,
} from '@agimon-ai/doompi-core/mcpToolResolver';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';

import { mountMcpHeadlessTools } from '../../../../../services/mcpHeadlessTools';
import { createMcpSessionToolsService, MCP_SESSION_TOOLS_SERVICE } from '../../../../../services/mcpSessionTools';
import { createMcpServerRuntime } from '../../../../../services/serverRuntime';

export const createMcpServerRoot = (context?: DoomServerPluginContext) => {
  const runtime = createMcpServerRuntime(context?.agent?.context?.environment, context?.host.context.workspaceRoot);
  const generation = `${context?.agent?.context?.sessionId ?? crypto.randomUUID()}:mcp-server`;
  const { session } = runtime;
  const mountSession = (cordis: Context) => {
    cordis.inject([DOOM_HEADLESS_HOST_SERVICE], (hostContext) => {
      const host = hostContext.get(DOOM_HEADLESS_HOST_SERVICE) as DoomHeadlessHostService;
      return host.subscribeSelection((selection) => runtime.onSelectionChange(selection));
    });
    cordis.plugin((provider) => {
      provider.provide(DOOM_MCP_STATUS_SERVICE, {
        generation,
        getSnapshot: () => session.getSnapshot(),
        onChange: (listener) => session.onChange(listener),
      } satisfies DoomMcpStatusService);
      provider.provide(DOOM_MCP_TOOL_RESOLVER_SERVICE, {
        generation,
        resolve: (selectors) => session.resolveToolSelectors(selectors),
      } satisfies DoomMcpToolResolverService);
      provider.provide(MCP_SESSION_TOOLS_SERVICE, createMcpSessionToolsService(session, generation));
      provider.provide(DOOM_CHILD_SESSION_MCP_TOOL_SERVICE, runtime.childTool);
    });
  };
  return {
    value: runtime,
    activities: runtime.activities,
    services: [mountMcpHeadlessTools(runtime.tools), mountSession],
  };
};
export type McpServerScope = Awaited<ReturnType<typeof createMcpServerRoot>>['value'];
