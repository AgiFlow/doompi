import { DOOM_CHILD_SESSION_MCP_TOOL_SERVICE } from '@agimon-ai/doompi-core/childSession';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessHostService,
  type DoomHeadlessRegistration,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import {
  DOOM_MCP_PROJECTION_RESOLVER_SERVICE,
  type DoomMcpProjectionResolverService,
} from '@agimon-ai/doompi-core/mcpProjection';
import { DOOM_MCP_STATUS_SERVICE, type DoomMcpStatusService } from '@agimon-ai/doompi-core/mcpStatus';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  type DoomMcpToolResolverService,
} from '@agimon-ai/doompi-core/mcpToolResolver';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';

import { createMcpAppsService } from '../../../../../services/mcpApps';
import { createConsentedFilePublisher } from '../../../../../services/mcpFileParams';
import { mountMcpHeadlessTools } from '../../../../../services/mcpHeadlessTools';
import { MCP_SESSION_TOOLS_SERVICE } from '../../../../../services/mcpSessionTools';
import { createMcpServerRuntime } from '../../../../../services/serverRuntime';

export const createMcpServerRoot = (context?: DoomServerPluginContext) => {
  let resolver: DoomMcpProjectionResolverService | undefined;
  let appHost = context?.agent;
  const hostContext = context?.host.context;
  // One consent point for model, widget, and child-session calls: each share asks the user.
  const publishFile =
    hostContext?.shareFile === undefined
      ? undefined
      : createConsentedFilePublisher({
          shareFile: (path, label) => hostContext.shareFile!(path, label),
          host: () => appHost,
          signal: context?.signal,
        });
  const runtime = createMcpServerRuntime(
    context?.agent?.context?.environment,
    context?.host.context.workspaceRoot,
    () => resolver,
    publishFile,
  );
  const generation = `${context?.agent?.context?.sessionId ?? crypto.randomUUID()}:mcp-server`;
  const { session } = runtime;
  const apps = createMcpAppsService(runtime.sessionTools, () => appHost, context?.signal);
  const mountSession = (cordis: Context) => {
    cordis.inject([DOOM_MCP_PROJECTION_RESOLVER_SERVICE], (resolverContext) => {
      resolver = resolverContext.get(DOOM_MCP_PROJECTION_RESOLVER_SERVICE) as DoomMcpProjectionResolverService;
      return () => {
        resolver = undefined;
      };
    });
    cordis.inject([DOOM_HEADLESS_HOST_SERVICE], (hostContext) => {
      const host = hostContext.get(DOOM_HEADLESS_HOST_SERVICE) as DoomHeadlessHostService;
      appHost = host;
      const registrations = new Map<string, { tool: DoomHeadlessTool; registration: DoomHeadlessRegistration }>();
      const reconcile = () => {
        const tools = runtime.sessionTools.project();
        const names = new Set(tools.map((tool) => tool.name));
        for (const [name, entry] of registrations) {
          if (names.has(name)) continue;
          entry.registration.dispose();
          registrations.delete(name);
        }
        for (const tool of tools) {
          const previous = registrations.get(tool.name);
          if (previous?.tool === tool) continue;
          previous?.registration.dispose();
          registrations.set(tool.name, { tool, registration: host.registerTool(tool) });
        }
      };
      // Subscribe before reading cached declarations or discovery can race registration.
      const stopTools = runtime.sessionTools.onChange(reconcile);
      const stopSelection = host.subscribeSelection((selection) => runtime.onSelectionChange(selection));
      reconcile();
      return () => {
        if (appHost === host) appHost = undefined;
        stopTools();
        stopSelection();
        for (const entry of registrations.values()) entry.registration.dispose();
        registrations.clear();
      };
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
      provider.provide(MCP_SESSION_TOOLS_SERVICE, runtime.sessionTools);
      provider.provide(DOOM_CHILD_SESSION_MCP_TOOL_SERVICE, runtime.childTool);
      return () => runtime.sessionTools.dispose();
    });
  };
  return {
    value: { ...runtime, appMethods: apps.methods },
    activities: runtime.activities,
    services: [mountMcpHeadlessTools(runtime.tools), mountSession],
    onDispose: apps.dispose,
  };
};
export type McpServerScope = Awaited<ReturnType<typeof createMcpServerRoot>>['value'];
