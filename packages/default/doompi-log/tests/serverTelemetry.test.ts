import type { DoomHeadlessExecutionContext, DoomHeadlessEventName } from '@agimon-ai/doompi-core/headless';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerTelemetry } from '../src/services/serverTelemetry';

const { createDoomTelemetry, telemetry } = vi.hoisted(() => {
  const telemetry = {
    recordEvent: vi.fn(async () => {}),
    recordDebug: vi.fn(async () => {}),
    recordWarning: vi.fn(async () => {}),
    recordError: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    status: vi.fn(() => ({ enabled: true, backend: 'otel' })),
  };
  return { telemetry, createDoomTelemetry: vi.fn(() => telemetry) };
});
vi.mock('@agimon-ai/doompi-telemetry', () => ({ createDoomTelemetry }));

const execution = {
  cwd: '/workspace/repo',
  sessionId: 'session-a',
  environment: { AGENT_OTEL_TRACES: 'false' },
  model: { provider: 'test-provider', id: 'requested-model' },
  client: { setStatus: vi.fn(), notify: vi.fn() },
} as unknown as DoomHeadlessExecutionContext;

function fixture() {
  const runtime = createServerTelemetry();
  const dispose = runtime.activities[0]!.start(execution);
  return {
    runtime,
    async emit(name: DoomHeadlessEventName, event: Record<string, unknown> = {}) {
      const hook = runtime.hooks.find((candidate) => candidate.event === name);
      expect(hook, `missing ${name} telemetry hook`).toBeDefined();
      await hook!.handle(event as never, execution);
    },
    async close() {
      await (
        await dispose
      )();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('server telemetry capture', () => {
  it('uses the session identity and respects the trace opt-out', async () => {
    const current = fixture();
    await current.emit('session_start');
    expect(createDoomTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'pi',
        packageName: '@agimon-ai/doompi-log',
        cwd: execution.cwd,
        env: { ...execution.environment, PI_SESSION_ID: 'session-a' },
        enableLogs: true,
        enableTraces: false,
      }),
    );
    await current.close();
  });

  it('records headless turn usage once, with safe tool attribution and model identity', async () => {
    const current = fixture();
    await current.emit('turn_start', { turnId: 'turn-a' });
    await current.emit('turn_end', {
      turnId: 'turn-a',
      message: {
        role: 'assistant',
        provider: 'test-provider',
        model: 'requested-model',
        responseModel: 'actual-model',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'private response' }],
        usage: {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 135,
          reasoning: 3,
          cost: { total: 0.02 },
        },
      },
      toolResults: [{ toolName: 'read', content: [{ type: 'text', text: 'private file' }] }],
    });
    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      'pi.turn.finished',
      expect.objectContaining({
        'pi.session.id': 'session-a',
        'gen_ai.provider.name': 'test-provider',
        'gen_ai.response.model': 'actual-model',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20,
        'gen_ai.usage.total_tokens': 135,
        'gen_ai.usage.cache_read_tokens': 10,
        'gen_ai.usage.cache_write_tokens': 5,
        'gen_ai.usage.reasoning_tokens': 3,
        'gen_ai.usage.cost': 0.02,
        'pi.turn.duration_ms': expect.any(Number),
      }),
    );
    expect(telemetry.recordDebug).toHaveBeenCalledWith(
      'pi.tool_token_sample',
      expect.objectContaining({
        'tool.name': 'read',
        token_attribution: 'toolCallTurn',
        'gen_ai.usage.total_tokens': 135,
      }),
    );
    expect(JSON.stringify(telemetry.recordEvent.mock.calls)).not.toContain('private');
    expect(JSON.stringify(telemetry.recordDebug.mock.calls)).not.toContain('private');
    await current.close();
  });

  it('records external tools without attributing an external model token budget', async () => {
    const current = fixture();
    await current.emit('tool_execution_start', {
      toolCallId: 'external-a',
      toolName: 'read',
      args: { path: 'private-path' },
    });
    await current.emit('tool_execution_end', {
      toolCallId: 'external-a',
      toolName: 'read',
      isError: true,
      result: { content: 'private-result' },
    });
    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      'pi.tool_result',
      expect.objectContaining({
        'tool.name': 'read',
        'tool.call.id': 'external-a',
        'tool.result.error': true,
        success: false,
        'tool.duration_ms': expect.any(Number),
      }),
    );
    expect(JSON.stringify(telemetry.recordEvent.mock.calls)).not.toMatch(/private|gen_ai.usage/);
    await current.close();
  });

  it('records failed and aborted turns without repeating usage on the failure marker', async () => {
    const current = fixture();
    for (const stopReason of ['error', 'aborted']) {
      await current.emit('turn_end', {
        turnId: stopReason,
        message: {
          role: 'assistant',
          model: 'test-model',
          stopReason,
          usage: { input: 10, output: 0, totalTokens: 10 },
        },
      });
    }
    expect(telemetry.recordError).toHaveBeenCalledWith(
      'pi.turn.failed',
      undefined,
      expect.objectContaining({ outcome: 'error' }),
    );
    expect(telemetry.recordWarning).toHaveBeenCalledWith(
      'pi.turn.failed',
      undefined,
      expect.objectContaining({ outcome: 'aborted' }),
    );
    expect(JSON.stringify(telemetry.recordError.mock.calls)).not.toContain('gen_ai.usage');
    await current.close();
  });

  it('ignores malformed usage and keeps lifecycle events usable', async () => {
    const current = fixture();
    await current.emit('turn_end', {
      message: { role: 'assistant', usage: { input: NaN, output: 'wrong', totalTokens: Infinity } },
    });
    await current.emit('turn_end', { message: { role: 'user', content: 'private' } });
    expect(JSON.stringify(telemetry.recordEvent.mock.calls)).not.toMatch(/gen_ai.usage|private/);
    await current.close();
  });

  it('awaits settled and shutdown records before flushing or disposing the exporter', async () => {
    const current = fixture();
    await current.emit('agent_settled');
    expect(telemetry.flush).toHaveBeenCalledOnce();
    await current.emit('session_shutdown');
    await current.close();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    expect(telemetry.recordEvent.mock.invocationCallOrder.at(-1)).toBeLessThan(
      telemetry.shutdown.mock.invocationCallOrder[0]!,
    );
    await current.emit('tool_execution_end', { toolCallId: 'late', toolName: 'read', isError: false });
    expect(telemetry.recordEvent).not.toHaveBeenCalledWith(
      'pi.tool_result',
      expect.objectContaining({ 'tool.call.id': 'late' }),
    );
  });
});
