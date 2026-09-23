import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { RUNNER_SERVER_SCOPE_SERVICE, type RunnerServerScope } from '../_lib/serverRoot';

export default defineMcpTool((context: DoomMcpPluginContext) => {
  const scope = context.services.get<RunnerServerScope>(RUNNER_SERVER_SCOPE_SERVICE);
  if (!scope) throw new Error('Runner session service is unavailable.');
  return {
    ...scope.tool,
    execute(toolCallId, parameters, signal, onUpdate, execution) {
      return scope.tool.execute(
        toolCallId,
        parameters,
        AbortSignal.any([context.signal, signal ?? context.signal]),
        onUpdate,
        execution,
      );
    },
  };
});
