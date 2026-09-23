import type {
  DoomHeadlessActivity,
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
} from '@agimon-ai/doompi-core/headless';
import { isRecord } from '@agimon-ai/doompi-core/runtimeJson';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';

import { PACKAGE_NAME, SERVICE_NAME } from '../../constants/telemetry';
import { isEnabled } from '../telemetryEnabled';

function contextAttributes(execution: DoomHeadlessExecutionContext): Record<string, unknown> {
  return {
    'pi.session.id': execution.sessionId,
    ...(execution.model === undefined
      ? {}
      : {
          'gen_ai.provider.name': execution.model.provider,
          'gen_ai.request.model': execution.model.id,
        }),
  };
}

/** Headless hooks carry untrusted records, not Pi's typed assistant messages. */
function usageAttributes(message: Record<string, unknown>): Record<string, unknown> {
  const usage = isRecord(message.usage) ? message.usage : {};
  const attributes: Record<string, unknown> = {};
  for (const [field, attribute] of Object.entries({
    input: 'gen_ai.usage.input_tokens',
    output: 'gen_ai.usage.output_tokens',
    cacheRead: 'gen_ai.usage.cache_read_tokens',
    cacheWrite: 'gen_ai.usage.cache_write_tokens',
    totalTokens: 'gen_ai.usage.total_tokens',
    reasoning: 'gen_ai.usage.reasoning_tokens',
  })) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) attributes[attribute] = value;
  }
  const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) attributes['gen_ai.usage.cost'] = cost;
  return attributes;
}

export function createServerTelemetry() {
  let telemetry: DoomTelemetry | undefined;
  const turns = new Map<string, number>();
  const tools = new Map<string, number>();
  let agentStartedAt: number | undefined;
  const activity: DoomHeadlessActivity = {
    name: PACKAGE_NAME,
    start(execution) {
      const current = createDoomTelemetry({
        serviceName: SERVICE_NAME,
        packageName: PACKAGE_NAME,
        cwd: execution.cwd,
        env: { ...execution.environment, PI_SESSION_ID: execution.sessionId },
        enableLogs: true,
        enableTraces:
          execution.environment.AGENT_OTEL_TRACES === undefined || isEnabled(execution.environment.AGENT_OTEL_TRACES),
      });
      telemetry = current;
      return async () => {
        if (telemetry === current) {
          telemetry = undefined;
          turns.clear();
          tools.clear();
          agentStartedAt = undefined;
        }
        await current.shutdown();
      };
    },
  };

  const command: DoomHeadlessCommand = {
    name: 'log-metrics',
    description: 'Show headless telemetry sink status.',
    async execute(_args, execution) {
      await execution.client.notify({
        title: 'DoomPi telemetry',
        body: JSON.stringify(telemetry?.status() ?? { active: false }, null, 2),
        level: 'info',
      });
    },
  };

  const hooks: DoomHeadlessHook[] = [
    {
      event: 'session_start',
      async handle(_event, execution) {
        await telemetry?.recordEvent('pi.session.started', contextAttributes(execution));
      },
    },
    {
      event: 'agent_settled',
      async handle(_event, execution) {
        const current = telemetry;
        await current?.recordEvent('pi.agent.settled', {
          ...contextAttributes(execution),
          ...(agentStartedAt === undefined ? {} : { 'pi.agent.duration_ms': Date.now() - agentStartedAt }),
        });
        agentStartedAt = undefined;
        turns.clear();
        await current?.flush();
      },
    },
    {
      event: 'session_shutdown',
      async handle(_event, execution) {
        await telemetry?.recordEvent('pi.session.stopped', contextAttributes(execution));
        execution.client.setStatus('doompi-log', undefined);
      },
    },
    {
      event: 'turn_start',
      async handle(event, execution) {
        if (!telemetry) return;
        if (typeof event.turnId === 'string') turns.set(event.turnId, Date.now());
        await telemetry.recordDebug('pi.turn.started', { ...contextAttributes(execution), 'pi.turn.id': event.turnId });
      },
    },
    {
      event: 'turn_end',
      async handle(event, execution) {
        const current = telemetry;
        if (!current) return;
        const startedAt = typeof event.turnId === 'string' ? turns.get(event.turnId) : undefined;
        if (typeof event.turnId === 'string') turns.delete(event.turnId);
        const message = isRecord(event.message) && event.message.role === 'assistant' ? event.message : undefined;
        const usage = message === undefined ? {} : usageAttributes(message);
        const attributes = {
          ...contextAttributes(execution),
          'pi.turn.id': event.turnId,
          ...(message === undefined
            ? {}
            : {
                'gen_ai.provider.name': message.provider ?? execution.model?.provider,
                'gen_ai.response.model': message.responseModel ?? message.model,
                'gen_ai.response.finish_reasons': message.stopReason,
              }),
        };
        const results = Array.isArray(event.toolResults) ? event.toolResults.filter(isRecord) : [];
        await current.recordEvent('pi.turn.finished', {
          ...attributes,
          ...usage,
          'pi.tool_result.count': results.length,
          ...(startedAt === undefined ? {} : { 'pi.turn.duration_ms': Date.now() - startedAt }),
        });
        if (message?.stopReason === 'error' || message?.stopReason === 'aborted') {
          const failure = {
            ...attributes,
            'error.type': 'ProviderError',
            'error.code': message.stopReason,
            outcome: message.stopReason === 'aborted' ? 'aborted' : 'error',
          };
          // Usage belongs to the finished record only, not the failure marker.
          if (message.stopReason === 'aborted') await current.recordWarning('pi.turn.failed', undefined, failure);
          else await current.recordError('pi.turn.failed', undefined, failure);
        }
        if (Object.keys(usage).length > 0) {
          for (const result of results) {
            await current.recordDebug('pi.tool_token_sample', {
              ...attributes,
              ...usage,
              'tool.name': result.toolName,
              token_attribution: 'toolCallTurn',
            });
          }
        }
      },
    },
    {
      event: 'tool_execution_start',
      async handle(event, execution) {
        if (!telemetry) return;
        if (typeof event.toolCallId === 'string') tools.set(event.toolCallId, Date.now());
        await telemetry.recordDebug('pi.tool_call', {
          ...contextAttributes(execution),
          'tool.name': event.toolName,
          'tool.call.id': event.toolCallId,
        });
      },
    },
    {
      event: 'tool_execution_end',
      async handle(event, execution) {
        const current = telemetry;
        if (!current) return;
        const startedAt = typeof event.toolCallId === 'string' ? tools.get(event.toolCallId) : undefined;
        if (typeof event.toolCallId === 'string') tools.delete(event.toolCallId);
        await current.recordEvent('pi.tool_result', {
          ...contextAttributes(execution),
          'tool.name': event.toolName,
          'tool.call.id': event.toolCallId,
          success: event.isError !== true,
          'tool.result.error': event.isError === true,
          ...(startedAt === undefined ? {} : { 'tool.duration_ms': Date.now() - startedAt }),
        });
        // External MCP calls have no agent_settled event to flush their results.
        if (typeof event.toolCallId === 'string' && event.toolCallId.startsWith('external-')) await current.flush();
      },
    },
    {
      event: 'agent_start',
      async handle(_event, execution) {
        if (!telemetry) return;
        agentStartedAt = Date.now();
        await telemetry.recordEvent('pi.agent.started', contextAttributes(execution));
      },
    },
  ];
  // Telemetry sink status is operator information, not model-actionable.
  return { activities: [activity], commands: [command], hooks };
}
