import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  extractForkFlag,
  parseSingleTaskToken,
  SlashParseError,
  type ParsedStep,
} from '../../../../../services/chainExpression';
import { normalizeParentModel } from '../../../../../services/modelFallback';
import { authenticatedModelInfos } from '../../../../../services/modelResolution';
import { captureSessionForkSource } from '../../../../../services/spawnPlan';
import { taskInputFromParsedStep, UnsupportedInlineConfigError } from '../../../../../services/spawnRequestMapping';
import { launchParallelSubagents } from '../../../../../services/subagentLaunch';
import type { AgentScope } from '../../../../../types/agent';
import type { TeamPiScope } from '../root.cli';
import {
  notifyError,
  reportSpawnResult,
  sessionScopeFor,
  type SlashCommandDeps,
  type SlashCommandState,
} from './_lib/launch';
import { readyCommand } from './_lib/ready';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  readyCommand(context.root, createParallelCommand(context.pi, context.root.state, context.root.slashCommandDeps));

export function createParallelCommand(
  pi: ExtensionAPI,
  state: SlashCommandState,
  deps: SlashCommandDeps,
): readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]] {
  return [
    'parallel',
    {
      description: 'Run agents in parallel: /parallel scout "task1" -> reviewer "task2" [--fork]',
      handler: async (args, ctx) => {
        const scope = sessionScopeFor(ctx, deps.environment);
        const jobs = deps.tracker.forSession(ctx.sessionManager.getSessionId(), scope);
        const { args: cleanedArgs, fork } = extractForkFlag(args);
        const baseCwd = requireBaseCwd(state, ctx);
        if (!baseCwd) return;

        const parsed = parseAgentArgsFallback(cleanedArgs);
        if (!parsed) {
          notifyError(ctx, 'Usage: /parallel agent1 "task1" -> agent2 "task2"');
          return;
        }
        for (const step of parsed.steps) {
          if (!findAgentOrNotify(deps, baseCwd, step.name, ctx)) return;
        }
        if (!parsed.steps.some((step) => step.task) && !parsed.task) {
          notifyError(ctx, 'At least one step must have a task');
          return;
        }

        try {
          const parentForkSource = captureSessionForkSource(ctx.sessionManager, 'settled');
          const parentModel = normalizeParentModel(ctx.model);
          const tasks = parsed.steps.map((step) =>
            taskInputFromParsedStep(
              { name: step.name, config: step.config, task: step.task ?? parsed.task },
              baseCwd,
              fork ? 'fork' : undefined,
            ),
          );
          const result = await launchParallelSubagents(
            deps.spawnPlanner,
            jobs,
            {
              tasks,
              cwd: baseCwd,
              agentScope: 'both',
              sessionScope: scope,
              parentSessionId: ctx.sessionManager.getSessionId(),
              ...(parentForkSource
                ? {
                    parentForkSource: parentForkSource.terminalSource,
                    ...(parentForkSource.sessionFile ? { parentSessionFile: parentForkSource.sessionFile } : {}),
                    parentLeafId: parentForkSource.leafId,
                  }
                : {}),
              availableModels: authenticatedModelInfos(ctx.modelRegistry),
              ...(parentModel ? { parentModel } : {}),
            },
            deps.loadConfig(),
          );
          reportSpawnResult(pi, ctx, deps, jobs, result);
        } catch (error) {
          reportKnownErrorOrRethrow(ctx, error);
        }
      },
    },
  ];
}

export function requireBaseCwd(state: SlashCommandState, ctx: ExtensionContext): string | undefined {
  if (state.baseCwd) return state.baseCwd;
  notifyError(ctx, 'Subagent session cwd is not initialized yet');
  return undefined;
}

export function findAgentOrNotify(
  deps: SlashCommandDeps,
  baseCwd: string,
  name: string,
  ctx: ExtensionContext,
): boolean {
  const agents = deps.discovery.discover(baseCwd, 'both' satisfies AgentScope).agents;
  if (agents.find((agent) => agent.name === name)) return true;
  notifyError(ctx, `Unknown agent: ${name}`);
  return false;
}

export function reportKnownErrorOrRethrow(ctx: ExtensionContext, error: unknown): void {
  if (error instanceof UnsupportedInlineConfigError || error instanceof SlashParseError) {
    notifyError(ctx, error.message);
    return;
  }
  throw error;
}

/**
 * Shared arg parsing for /chain (no inline group) and /parallel:
 * "agent1 task1 -> agent2 task2" or "agent1 agent2 -- shared task".
 */
export function parseAgentArgsFallback(
  input: string,
): { steps: ParsedStep[]; task: string; perStep: boolean } | undefined {
  const trimmed = input.trim();
  if (trimmed.includes(' -> ')) {
    const steps = trimmed
      .split(' -> ')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => parseSingleTaskToken(segment));
    if (steps.length === 0) return undefined;
    return { steps, task: steps.find((step) => step.task)?.task ?? '', perStep: true };
  }
  const delimiterIndex = trimmed.indexOf(' -- ');
  if (delimiterIndex === -1) return undefined;
  const agentsPart = trimmed.slice(0, delimiterIndex).trim();
  const sharedTask = trimmed.slice(delimiterIndex + 4).trim();
  if (!agentsPart || !sharedTask) return undefined;
  const steps = agentsPart
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => parseSingleTaskToken(token));
  if (steps.length === 0) return undefined;
  return { steps, task: sharedTask, perStep: false };
}
