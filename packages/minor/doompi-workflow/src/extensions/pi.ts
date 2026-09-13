import { definePiExtension, definePiTool } from '@agimon-ai/doompi-core/pi-extension';
import { DOOM_SKILL_SOURCES_SERVICE, requireDoomSkillSourcesService } from '@agimon-ai/doompi-core/skills';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-core/ui-hub';
import type { Context } from '@deepseek-ai/cordis';

import { PACKAGE_SOURCE } from '../constants/workflow';
import {
  createWorkflowFence,
  dispatcherTools,
  dispatcherToolRestriction,
  isWorkflowDispatcherProcess,
  resolveDispatcherParentSession,
} from '../services/workflowFence';
import { workflowSkillDirectory } from '../services/workflowResource';
import { createWorkflowTools } from '../tools/workflowTools';
import { registerLeaderContribution } from '../tui/leader';
import { renderWorkflowToolCall, renderWorkflowToolResult } from '../tui/workflow/workflowToolRender';
import { createWorkflowPiRuntime, type WorkflowPiExtensionOptions } from '../tui/workflowRuntime';

export const workflowExtension = definePiExtension<Partial<WorkflowPiExtensionOptions>>(
  PACKAGE_SOURCE,
  ({ pi, context, options, signal }) => {
    const environment = options?.environment ?? Object.freeze({ ...process.env });
    const dispatcher = isWorkflowDispatcherProcess(environment);
    const fence = createWorkflowFence(pi, signal);
    let workflowMode = false;
    let leader: ReturnType<typeof registerLeaderContribution> | undefined;
    const runtime = createWorkflowPiRuntime(fence.pi, {
      ...options,
      environment,
      cordis: context,
      initialMode: dispatcher || options?.initialMode,
      isActive: fence.isCurrentInvocation,
      runCleanup: fence.runCleanup,
      onModeChange(enabled) {
        workflowMode = enabled;
        leader?.setMode(enabled);
        options?.onModeChange?.(enabled);
      },
    });
    const nativeTools = createWorkflowTools(runtime.toolDependencies, (name) => ({
      renderCall: (args, theme) => renderWorkflowToolCall(name, args as Record<string, unknown>, theme),
      renderResult: (result, renderOptions, theme, renderContext) =>
        renderWorkflowToolResult(
          name,
          renderContext.args as Record<string, unknown>,
          result,
          { ...renderOptions, isError: renderContext.isError },
          theme,
        ),
    }));
    const selectedTools = dispatcher
      ? dispatcherTools(nativeTools, resolveDispatcherParentSession(environment), environment)
      : nativeTools;
    return {
      services: [
        ...(runtime.services ?? []),
        (cordis: Context) => {
          cordis.inject([DOOM_SKILL_SOURCES_SERVICE], (skillContext) => {
            const directory = workflowSkillDirectory();
            const contribution = requireDoomSkillSourcesService(skillContext).register({
              source: PACKAGE_SOURCE,
              directories: [directory],
            });
            return () => contribution.dispose();
          });
          if (!dispatcher)
            cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
              const contribution = registerLeaderContribution(requireDoomUiHub(uiContext), workflowMode);
              leader = contribution;
              return () => {
                contribution.dispose();
                if (leader === contribution) leader = undefined;
              };
            });
        },
      ],
      tools: selectedTools.map((tool) =>
        definePiTool(
          fence.tool({
            ...tool,
            async execute(...args) {
              await runtime.waitForReadiness(args[2]);
              return tool.execute(...args);
            },
          }),
        ),
      ),
      commands: runtime.commands.map(([name, command]) => fence.command(name, command)),
      shortcuts: runtime.shortcuts?.map(([key, shortcut]) => fence.shortcut(key, shortcut)),
      events: fence.events(runtime.events ?? {}),
      messageRenderers: runtime.messageRenderers,

      toolRestrictions: [
        ...(runtime.toolRestrictions ?? []),
        ...(dispatcher ? [{ source: `${PACKAGE_SOURCE}/dispatcher`, restrict: dispatcherToolRestriction() }] : []),
      ],
      resources: dispatcher
        ? []
        : [
            {
              source: PACKAGE_SOURCE,
              moduleUrl: import.meta.url,
              skills: [
                {
                  name: 'doompi-author-workflow',
                  description: 'Author DoomPi workflow definitions, job dependencies and host-executed steps.',
                },
                {
                  name: 'doompi-use-workflow',
                  description: 'Discover, launch, monitor, control and recover DoomPi workflow runs.',
                },
              ],
            },
          ],
      async onStop() {
        fence.beginDisposal();
        await fence.runCleanup(() => runtime.dispose());
      },
      async onDispose() {
        fence.beginDisposal();
        try {
          await fence.runCleanup(() => runtime.dispose());
        } finally {
          fence.finishDisposal();
        }
      },
    };
  },
);
export default workflowExtension;
