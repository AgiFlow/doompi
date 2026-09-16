import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext, PiToolCollection } from '@agimon-ai/doompi-core/pi-extension';

import { createMcpToolCollection } from '../../../../../services/mcpToolCollection';
import { renderMcpCall, renderMcpResult } from '../../../../../tui/mcpToolRender';
import type { McpPiScope } from '../_lib/piRoot';

export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, McpPiScope>): PiToolCollection =>
    createMcpToolCollection(context.root.session, (tool) => ({
      renderCall: (params, theme) => renderMcpCall(tool, params as Record<string, unknown>, theme),
      renderResult: (result, options, theme, execution) =>
        renderMcpResult(result, { ...options, isError: execution.isError }, theme),
    })),
  { cardinality: 'collection' },
);
