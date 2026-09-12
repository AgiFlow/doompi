import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import type { BashParams } from '../schemas/bashTool';
import { createBashTool } from '../tools/bashTool';
import { renderBashCall, renderBashResult } from '../tui/bashRender';
import { createRunnerRuntime } from '../tui/runnerRuntime';
export const runnerExtension = definePiExtension('@agimon-ai/doompi-runner', ({ pi }) => {
  const runtime = createRunnerRuntime(pi);
  return {
    services: [runtime.plugin],
    events: runtime.events,
    commands: [runtime.command],
    tools: [
      createBashTool(runtime.bashTool, {
        renderCall(args, theme) {
          return renderBashCall(args as BashParams, theme);
        },
        renderResult(result, options, theme, context) {
          return renderBashResult(result, { ...options, isError: context.isError }, theme);
        },
      }),
    ],
    onStart: runtime.start,
    onStop: runtime.stop,
    resources: [
      {
        source: '@agimon-ai/doompi-runner',
        moduleUrl: import.meta.url,
        skills: [
          {
            name: 'doompi-use-runner',
            description:
              'Use Doom Pi Runner to supervise shell commands, inspect durable logs, provide interactive input, and stop background runs.',
          },
        ],
      },
    ],
  };
});
export default runnerExtension;
