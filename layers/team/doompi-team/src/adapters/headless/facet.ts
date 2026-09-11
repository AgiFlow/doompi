import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessTool,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_BACKGROUND_WORK_SERVICE } from '@agimon-ai/doompi-extension-contracts/background-work';
import { DOOM_DELEGATION_SERVICE } from '@agimon-ai/doompi-extension-contracts/delegation';
import { DOOM_SUBAGENT_POLICY_SERVICE } from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import type { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import {
  SUBAGENT_ACTIONS,
  SubagentParams,
  type SubagentToolParams,
} from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import { createBackgroundWorkService } from '../../services/backgroundWorkService.ts';
import { toModelInfo } from '../../services/models/modelInfo.ts';
import { createSubagentPolicyService } from '../../services/subagentPolicyService.ts';
import { createTeamExtensionRuntime } from '../pi/teamRuntime.ts';
import { createDelegationBridge } from '../pi/extensions/delegationBridge.ts';
import { loadConfig } from '../pi/extensions/config.ts';
import { resolveTrackedRunId } from '../asyncJobTracker.ts';
import { listSuspendedRuns, isSuspendedRunResumable, formatSuspendedRuns } from '../suspendedRuns.ts';
import { createSessionScope, setCurrentSessionScope } from '../filesystem/paths.ts';
import { openScopeAsync, suspendScopeRuns } from '../runs/registry/sessionLifecycle.ts';
import { writeScopeOwnerAsync } from '../scopeOwner.ts';
import type { NativeTeamRuntime, NativeTeamTransport } from '../intercom/nativeTeamChannel.ts';
import { DoomTeamExpectedError } from '../../services/support/errors.ts';

const SOURCE = '@agimon-ai/doompi-team';
const SUBAGENT_DESCRIPTION =
  'Discover agents, start and manage persistent background subagent runs, and inspect suspended work.';

type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

function result(value: unknown, isError = false): DoomHeadlessToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], details: value, ...(isError ? { isError: true } : {}) };
}

function scopeOf(value: string | undefined): 'user' | 'project' | 'both' {
  return value === 'user' || value === 'project' ? value : 'both';
}

type HeadlessTeamServicesConfig = {
  readonly bridge: ReturnType<typeof createDelegationBridge>;
  readonly runtime: ReturnType<typeof createTeamExtensionRuntime>;
  readonly execution: DoomHeadlessExecutionContext;
};

/** Mount Team's session services under a Cordis-owned plugin fiber. */
function headlessTeamServicesPlugin(ctx: Context, config: HeadlessTeamServicesConfig): void {
  const availableModels = config.execution.model ? [toModelInfo(config.execution.model)] : [];
  ctx.provide(
    DOOM_DELEGATION_SERVICE,
    config.bridge.createService(ctx, {
      sessionId: config.execution.sessionId,
      availableModels,
      ...(config.execution.model ? { parentModel: config.execution.model } : {}),
    }),
  );
  ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, createBackgroundWorkService(ctx));
  ctx.provide(DOOM_SUBAGENT_POLICY_SERVICE, createSubagentPolicyService(config.runtime.capabilityPolicies));
}

function subagentTool(
  runtime: ReturnType<typeof createTeamExtensionRuntime>,
  execution: DoomHeadlessExecutionContext,
): DoomHeadlessTool<typeof SubagentParams> {
  const jobs = runtime.asyncJobTracker.forSession(execution.sessionId);
  const availableModels = execution.model ? [toModelInfo(execution.model)] : [];
  return {
    name: 'subagent',
    label: 'Subagent',
    description: SUBAGENT_DESCRIPTION,
    parameters: SubagentParams,
    promptSnippet: 'Discover, run, inspect, steer, stop, and restore persistent subagents',
    promptGuidelines: [
      'Runs are persistent background work. Do not resubmit a run that already returned an id.',
      'Use status or suspended before retrying a failed or interrupted operation.',
    ],
    executionMode: 'serial',
    async execute(_toolCallId, parameters, signal, onUpdate) {
      if (!Check(SubagentParams, parameters)) return result('Invalid subagent parameters.', true);
      const params = parameters as SubagentToolParams;
      try {
        if (params.action === SUBAGENT_ACTIONS.agents) {
          const scope = scopeOf(params.scope);
          const agents = runtime.discovery.discover(params.cwd ?? execution.cwd, scope).agents;
          const selected = params.name
            ? runtime.discovery.find(params.cwd ?? execution.cwd, scope, params.name)
            : undefined;
          if (params.name && !selected)
            throw new DoomTeamExpectedError(
              'agent_not_found',
              `No executable agent matches '${params.name}'.`,
              false,
              'Call subagent({"action":"agents"}) and retry with an exact agent name.',
            );
          return result({
            agents: selected
              ? [selected]
              : agents.map((agent) => ({
                  name: agent.name,
                  source: agent.source,
                  description: agent.description,
                  runtime: agent.runtime ?? 'pi',
                })),
          });
        }
        if (params.action === SUBAGENT_ACTIONS.run) {
          onUpdate?.(
            result(`Starting ${params.requests.length} subagent${params.requests.length === 1 ? '' : 's'}...`),
          );
          const plan = await runtime.spawnPlanner.spawn(
            {
              tasks: params.requests.map((request) => ({
                agent: request.agent.trim(),
                task: request.task.trim(),
                ...(request.inlineAgent ? { inlineAgent: request.inlineAgent } : {}),
                ...(request.cwd ? { cwd: request.cwd } : {}),
                ...(request.model ? { model: request.model } : {}),
                ...(request.runtime ? { runtime: request.runtime } : {}),
              })),
              cwd: execution.cwd,
              agentScope: scopeOf(params.scope),
              parentSessionId: execution.sessionId,
              ...(params.concurrency === undefined ? {} : { concurrency: params.concurrency }),
              ...(params.artifacts === undefined ? {} : { artifacts: params.artifacts }),
              availableModels,
              ...(execution.model ? { parentModel: execution.model } : {}),
            },
            loadConfig().config,
          );
          for (const outcome of plan.outcomes) if (outcome.runId) jobs.track(outcome.runId);
          return result(plan);
        }
        if (params.action === SUBAGENT_ACTIONS.status) {
          if (!('id' in params)) return result({ runs: jobs.list() });
          const status = runtime.management.status(params.id);
          return result({ runId: status.runId, status: status.status });
        }
        if (params.action === SUBAGENT_ACTIONS.suspended) {
          const suspended = listSuspendedRuns(createSessionScope(execution.sessionId));
          return result({
            suspended,
            text: suspended.length ? formatSuspendedRuns(suspended) : 'No suspended subagents in this session.',
          });
        }
        const id = resolveTrackedRunId(jobs, params.id);
        if (params.action === SUBAGENT_ACTIONS.stop) {
          return result({ runId: id, control: runtime.management.stop(id, params.reason) });
        }
        if (params.action === SUBAGENT_ACTIONS.steer) {
          const steer = await runtime.management.steer(id, params.message, undefined, signal);
          return result({ runId: id, steer });
        }
        const suspended = listSuspendedRuns(createSessionScope(execution.sessionId)).find(
          (item) => item.runId === params.id,
        );
        if (!suspended) throw new Error(`No suspended run matches '${params.id}'.`);
        if (!isSuspendedRunResumable(suspended)) throw new Error(`Suspended run '${params.id}' is not resumable.`);
        const restored = await runtime.spawnPlanner.spawn(
          {
            single: {
              agent: suspended.agent,
              task: suspended.task,
              cwd: suspended.cwd,
              sessionFile: suspended.sessionFile,
            },
            cwd: suspended.cwd,
            agentScope: 'both',
            runtime: 'pi',
            parentSessionId: execution.sessionId,
            availableModels,
          },
          loadConfig().config,
        );
        return result(restored);
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}

function intercomTool(channel: NativeTeamRuntime): DoomHeadlessTool {
  return {
    name: 'intercom',
    label: 'Intercom',
    description: 'Communicate with active agents in this root session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['members', 'send', 'ask', 'pending', 'reply'] },
        to: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      required: ['action'],
    },
    executionMode: 'serial',
    async execute(toolCallId, parameters, signal, onUpdate) {
      return channel.execute(toolCallId, parameters, signal, onUpdate);
    },
  };
}

export const teamHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const runtime = createTeamExtensionRuntime();
    const execution = host.context;
    const scope = createSessionScope(execution.sessionId);
    const bridge = createDelegationBridge({
      planner: runtime.spawnPlanner,
      management: runtime.management,
      waiter: runtime.subagentWaiter,
      scheduler: runtime.pollScheduler,
      tracker: runtime.asyncJobTracker,
      loadConfig: () => loadConfig().config,
    });
    context.plugin(headlessTeamServicesPlugin, { bridge, runtime, execution });
    runtime.pollScheduler.start();
    runtime.asyncJobTracker.start();
    const transport: NativeTeamTransport = {
      sendMessage: ((message) =>
        void execution.client.notify({
          body:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => ('text' in part ? part.text : '[image]')).join('\n'),
          level: 'info',
        })) as NativeTeamTransport['sendMessage'],
      sendUserMessage: ((message) =>
        void execution.session.prompt(
          typeof message === 'string'
            ? message
            : message.map((part) => ('text' in part ? part.text : '[image]')).join('\n'),
          'steer',
        )) as NativeTeamTransport['sendUserMessage'],
    };
    const channel = runtime.teamChannel.createHeadlessRuntime(transport);
    const registrations = [
      host.registerTool(subagentTool(runtime, execution)),
      host.registerTool(intercomTool(channel)),
      host.registerResource({
        name: 'doompi/team',
        kind: 'context',
        read: () =>
          JSON.stringify(
            { sessionId: execution.sessionId, members: channel.current() ? [channel.current()] : [] },
            null,
            2,
          ),
      }),
      host.registerActivity({
        name: SOURCE,
        async start(activityContext) {
          setCurrentSessionScope(createSessionScope(activityContext.sessionId));
          await writeScopeOwnerAsync(scope);
          const opened = await openScopeAsync(scope, {
            readStatus: (runId) => runtime.management.status(runId).status,
          });
          if (opened.suspended.length)
            await activityContext.client.notify({ body: formatSuspendedRuns(opened.suspended), level: 'info' });
          channel.bindMainSession(activityContext.sessionId);
          return () => {
            // Optional disable only detaches the communication member. Jobs and
            // their tracker remain available for a later activation.
            channel.dispose();
          };
        },
      }),
    ];
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations.reverse()) registration.dispose();
      channel.dispose();
      void suspendScopeRuns({
        scope,
        reason: 'headless session ended',
        readStatus: (runId) => runtime.management.status(runId).status,
      }).catch((error) => process.emitWarning(`Could not suspend headless Team runs: ${String(error)}`));
      bridge.abandonAll();
      runtime.asyncJobTracker.stop();
      runtime.pollScheduler.stop();
    };
  },
};
