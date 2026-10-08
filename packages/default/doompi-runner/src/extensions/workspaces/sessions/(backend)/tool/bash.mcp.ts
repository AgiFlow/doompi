import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { RUNNER_SERVER_SCOPE_SERVICE, type RunnerServerScope } from '../_lib/serverRoot';

const pollHint = (id: string): string =>
  `You will not be notified when this runner ends. Check it with \`doom-runner status ${id}\` and read output with \`doom-runner logs ${id} --lines 100\`, both through this tool, until State is completed.`;

export default defineMcpTool((context: DoomMcpPluginContext) => {
  const scope = context.services.get<RunnerServerScope>(RUNNER_SERVER_SCOPE_SERVICE);
  if (!scope) throw new Error('Runner session service is unavailable.');
  return {
    ...scope.remoteTool,
    description:
      "Run a shell command (bash, terminal, CLI) in the DoomPi session's repository on the host machine, not on your local machine. Use it for tests, builds, linters, git, and package scripts. Short commands return bounded output. Long-running ones return a runner id. No completion notice reaches you, so check them with `doom-runner status <id>` and `doom-runner logs <id> --lines 100` instead of relaunching.",
    async execute(toolCallId, parameters, signal, onUpdate, execution) {
      const result = await scope.remoteTool.execute(
        toolCallId,
        parameters,
        AbortSignal.any([context.signal, signal ?? context.signal]),
        onUpdate,
        execution,
      );
      const details = result.details as { promoted?: unknown; id?: unknown } | undefined;
      if (details?.promoted !== true || typeof details.id !== 'string') return result;
      return { ...result, content: [...result.content, { type: 'text', text: pollHint(details.id) }] };
    },
  };
});
