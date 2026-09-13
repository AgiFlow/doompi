import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { PACKAGE_SOURCE } from '../constants/piMcp';
import { createMcpCommand } from '../controllers/mcpCommand';
import { createMcpPiRuntime } from '../controllers/piRuntime';
import { createMcpToolCollection } from '../tools/mcpToolCollection';
import { renderMcpCall, renderMcpResult } from '../tui/mcpToolRender';
export const mcpExtension = definePiExtension(PACKAGE_SOURCE, ({ runtime }) => {
  if (!runtime) throw new Error('MCP requires the Cordis runtime mode.');
  const state = createMcpPiRuntime(runtime);
  return {
    services: state.services,
    tools: createMcpToolCollection(state.session, (tool) => ({
      renderCall: (params, theme) => renderMcpCall(tool, params as Record<string, unknown>, theme),
      renderResult: (result, options, theme, context) =>
        renderMcpResult(result, { ...options, isError: context.isError }, theme),
    })),
    commands: [
      createMcpCommand(state.session, {
        openOverlay: async (ctx) => {
          const { openMcpOverlay } = await import('../tui/mcpOverlay');
          return openMcpOverlay(ctx, state.session);
        },
      }),
    ],
    onDispose: () => state.onDispose(),
    resources: [
      {
        source: PACKAGE_SOURCE,
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-mcp',
            description:
              'Use Doom Pi MCP to inspect domain-scoped servers, authenticate, reload configuration, and troubleshoot tool availability.',
          },
        ],
      },
    ],
  };
});
export default mcpExtension;
