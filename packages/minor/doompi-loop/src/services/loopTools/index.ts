import { defineTool, type DoomPluginTool, type DoomPluginToolResult } from '@agimon-ai/doompi-core/piExtension';
import { Check } from 'typebox/value';

import type { DoomLoopLaunchersService } from '../../schemas/loopLaunchers';
import { LoopListSchema, LoopStartSchema, LoopStopSchema } from '../../schemas/loopTools';

function result(details: unknown): DoomPluginToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details };
}

export function createLoopTools(
  launchers: () => DoomLoopLaunchersService,
  assertEnabled: () => void,
): readonly DoomPluginTool[] {
  return [
    defineTool({
      name: 'loop_list',
      label: 'List loops',
      description: 'List active session loops and available launcher types with their configuration schemas.',
      parameters: LoopListSchema,
      async execute(input, { signal }) {
        assertEnabled();
        signal?.throwIfAborted();
        if (!Check(LoopListSchema, input)) throw new Error('loop_list takes no arguments.');
        const service = launchers();
        return result({ launchers: service.listLaunchers(), instances: service.listInstances() });
      },
    }),
    defineTool({
      name: 'loop_start',
      label: 'Start loop',
      description:
        'Start a session-scoped loop without operator dialogs. Read loop_list for launcher IDs and input schemas. Loops stop when the session shuts down.',
      parameters: LoopStartSchema,
      executionMode: 'serial',
      async execute(input, { signal }) {
        assertEnabled();
        signal?.throwIfAborted();
        if (!Check(LoopStartSchema, input)) throw new Error('Provide launcherId, input, and optionally instanceId.');
        return result(
          (await launchers().launch(input.launcherId, { ...input, interactive: false, signal })) ?? { cancelled: true },
        );
      },
    }),
    defineTool({
      name: 'loop_stop',
      label: 'Stop loop',
      description:
        'Stop one loop instance owned by the current session. Does not disable Loop mode or stop other loops.',
      parameters: LoopStopSchema,
      executionMode: 'serial',
      async execute(input, { signal }) {
        assertEnabled();
        signal?.throwIfAborted();
        if (!Check(LoopStopSchema, input)) throw new Error('Provide instanceId and an optional reason.');
        return result({ stopped: await launchers().stop(input.instanceId, input.reason ?? 'Stopped by the agent.') });
      },
    }),
  ];
}
