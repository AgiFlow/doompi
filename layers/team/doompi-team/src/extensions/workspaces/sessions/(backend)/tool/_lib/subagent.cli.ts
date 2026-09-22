import { defineCliTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import { definePiTool, type PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { SubagentToolSchema } from '../../../../../../schemas/subagentTool';
import { DoomTeamExpectedError } from '../../../../../../services/errors';
import {
  SUBAGENT_TOOL_NAME,
  validateParams,
  type SubagentToolContract,
  type SubagentToolDetails,
} from '../../../../../../services/subagentTool';
import { SUBAGENT_TOOL_DESCRIPTION } from '../../../../../../services/toolDescription';
import type { TeamPiScope } from '../../_lib/root.cli';

export default defineCliTool((context: WithRoot<PiPluginContext, TeamPiScope>) =>
  definePiTool(
    createSubagentTool(context.root.runtime.subagentTool, context.pi, {}, context.root.waitForSessionReadiness),
  ),
);

export function createSubagentTool(
  service: SubagentToolContract,
  pi: Pick<ExtensionAPI, 'getAllTools'>,
  renderers: Partial<
    Pick<ToolDefinition<typeof SubagentToolSchema, SubagentToolDetails>, 'renderCall' | 'renderResult'>
  >,
  waitUntilReady: (context: ExtensionContext, signal?: AbortSignal) => Promise<void>,
): ToolDefinition<typeof SubagentToolSchema, SubagentToolDetails> {
  let conflict = false;
  try {
    conflict = pi.getAllTools().some((tool) => tool.name === SUBAGENT_TOOL_NAME);
  } catch {
    /* Host discovery can be unavailable during installation. */
  }
  if (conflict)
    throw new DoomTeamExpectedError(
      'tool_conflict',
      `A foreign '${SUBAGENT_TOOL_NAME}' tool is already registered.`,
      false,
      'Disable the competing extension, then reload Doom Team.',
    );
  return {
    name: SUBAGENT_TOOL_NAME,
    label: 'Subagent',
    description: SUBAGENT_TOOL_DESCRIPTION,
    parameters: SubagentToolSchema,
    prepareArguments: validateParams,
    renderShell: 'self',
    ...renderers,
    async execute(id, params, signal, onUpdate, context) {
      await waitUntilReady(context, signal);
      return service.execute(id, params, signal, onUpdate, context);
    },
  };
}
