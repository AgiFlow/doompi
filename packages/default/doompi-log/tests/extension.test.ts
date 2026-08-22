import type {
  NodeTelemetryHandle,
  NodeTelemetryLogger,
  NodeTelemetryLogOptions,
  NodeTelemetryOptions,
} from '@agimon-ai/log-sink-mcp/telemetry/node';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installLogTestRuntime, installTelemetryTestRuntime } from './helpers/extensionRuntime.ts';

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => Promise<void>;

function createContext(): ExtensionContext {
  return {
    cwd: '/workspace',
    mode: 'json',
    thinkingLevel: 'medium',
    model: { provider: 'openai-codex', id: 'gpt-5.6' },
    sessionManager: {
      getSessionId: () => 'pi-session',
      getSessionFile: () => '/workspace/session.jsonl',
    },
  } as unknown as ExtensionContext;
}

function createTelemetryDouble(backend: NodeTelemetryHandle['backend'] = 'logsink') {
  const records: Array<{ level: string; message: string; attributes?: NodeTelemetryLogOptions['attributes'] }> = [];
  // The level is captured because a failed turn has to arrive as an error, not
  // as one more info record nobody alerts on.
  const record = (level: string) => (message: string, options?: NodeTelemetryLogOptions) => {
    records.push({ level, message, attributes: options?.attributes });
  };
  const logger: NodeTelemetryLogger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    getTraceContext: () => ({}),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  const telemetry = {
    backend,
    enabled: true,
    logger,
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as unknown as NodeTelemetryHandle;
  const telemetryFactory = vi.fn(async (_options: NodeTelemetryOptions) => telemetry);
  return { records, telemetry, telemetryFactory };
}

async function emit(handlers: Map<string, Handler>, name: string, event: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing handler: ${name}`);
  await handler({ type: name, ...event }, createContext());
}

describe('log-sink Pi telemetry entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records failed tool results without tool payloads by default', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const { records, telemetryFactory } = createTelemetryDouble();
    installTelemetryTestRuntime(pi, { env: { AGENT_SESSION_ID: 'agent-session' }, telemetryFactory });
    const context = createContext();

    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, context);
    await handlers.get('tool_execution_start')?.(
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'private' } },
      context,
    );
    await handlers.get('tool_execution_end')?.(
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        result: { output: 'private' },
        isError: true,
      },
      context,
    );

    expect(telemetryFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'pi',
        headers: {
          'x-agent': 'pi',
          'x-agent-session-id': expect.stringMatching(/^id_[0-9a-f]+$/),
        },
      }),
    );
    expect(records.find((record) => record.message === 'pi.tool_result')?.attributes).toMatchObject({
      success: false,
      'tool.name': 'bash',
      'tool.result.error': true,
    });
    expect(JSON.stringify(records)).not.toContain('private');
  });

  it('uses a caller-provided service identity instead of the default', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const { telemetryFactory } = createTelemetryDouble();

    installTelemetryTestRuntime(pi, { serviceName: 'custom-service', telemetryFactory });
    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, createContext());

    expect(telemetryFactory).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'custom-service' }));
  });

  it('degrades safely when telemetry initialization fails', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const onDiagnostic = vi.fn();
    const telemetryFactory = vi.fn(async () => {
      throw new Error('sink unavailable');
    });
    installTelemetryTestRuntime(pi, { telemetryFactory, onDiagnostic });

    await expect(
      handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, createContext()),
    ).resolves.toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith('Doom telemetry initialization failed: Error: sink unavailable');
  });

  it('records lifecycle, provider, model, and token usage events', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const { records, telemetry, telemetryFactory } = createTelemetryDouble();
    installTelemetryTestRuntime(pi, { telemetryFactory });

    await emit(handlers, 'session_start', { reason: 'startup' });
    await emit(handlers, 'before_agent_start', { prompt: 'hello', images: [] });
    await emit(handlers, 'agent_start', {});
    await emit(handlers, 'turn_start', { turnIndex: 1, timestamp: Date.now() });
    await emit(handlers, 'turn_end', {
      turnIndex: 1,
      toolResults: [],
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6',
        stopReason: 'stop',
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 19,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
      },
    });
    await emit(handlers, 'after_provider_response', { status: 200, headers: {} });
    await emit(handlers, 'after_provider_response', { status: 500, headers: {} });
    await emit(handlers, 'model_select', {
      source: 'set',
      model: { provider: 'anthropic', id: 'claude' },
      previousModel: undefined,
    });
    await emit(handlers, 'agent_end', { messages: [] });
    await emit(handlers, 'agent_settled', {});
    await emit(handlers, 'session_shutdown', { reason: 'quit' });

    expect(records.map((record) => record.message)).toEqual(
      expect.arrayContaining([
        'pi.session.started',
        'pi.user_prompt',
        'pi.agent.started',
        'pi.turn.started',
        'pi.turn.finished',
        'pi.api_response',
        'pi.api_error',
        'pi.model.selected',
        'pi.agent.finished',
        'pi.agent.settled',
        'pi.session.finished',
      ]),
    );
    expect(records.find((record) => record.message === 'pi.turn.finished')?.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.total_tokens': 19,
    });
    expect(telemetry.flush).toHaveBeenCalledTimes(2);
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('never records prompts or tool payloads, even when the legacy opt-in is present', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const { records, telemetryFactory } = createTelemetryDouble();
    installTelemetryTestRuntime(pi, { env: { AGENT_OTEL_REDACT: '0' }, telemetryFactory });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await emit(handlers, 'before_agent_start', { prompt: 'private prompt', images: [] });
    await emit(handlers, 'tool_execution_start', {
      toolCallId: 'tool-2',
      toolName: 'read',
      args: circular,
    });
    await emit(handlers, 'tool_execution_end', {
      toolCallId: 'tool-2',
      toolName: 'read',
      result: { output: 'private output' },
      isError: false,
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('private output');
    expect(records.find((record) => record.message === 'pi.user_prompt')?.attributes ?? {}).not.toHaveProperty(
      'user.prompt',
    );
    expect(records.find((record) => record.message === 'pi.tool_call')?.attributes ?? {}).not.toHaveProperty(
      'tool.input',
    );
    expect(records.find((record) => record.message === 'pi.tool_result')?.attributes ?? {}).not.toHaveProperty(
      'tool.result',
    );
  });

  it('honors opt-out and skips local file fallback', async () => {
    const disabledHarness = new Map<string, Handler>();
    const disabledPi = {
      on: vi.fn((event: string, handler: Handler) => disabledHarness.set(event, handler)),
    } as unknown as ExtensionAPI;
    const disabled = createTelemetryDouble();
    installTelemetryTestRuntime(disabledPi, {
      env: { AGENT_TELEMETRY_DISABLED: '1' },
      telemetryFactory: disabled.telemetryFactory,
    });

    await emit(disabledHarness, 'session_start', { reason: 'startup' });
    expect(disabled.telemetryFactory).not.toHaveBeenCalled();

    const fileHarness = new Map<string, Handler>();
    const filePi = {
      on: vi.fn((event: string, handler: Handler) => fileHarness.set(event, handler)),
    } as unknown as ExtensionAPI;
    const file = createTelemetryDouble('file');
    installTelemetryTestRuntime(filePi, { telemetryFactory: file.telemetryFactory });

    await emit(fileHarness, 'session_start', { reason: 'startup' });
    expect(file.records).toHaveLength(0);
    expect(file.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  describe('failed turns', () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    async function emitTurn(message: Record<string, unknown>) {
      const handlers = new Map<string, Handler>();
      const pi = {
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
      } as unknown as ExtensionAPI;
      const { records, telemetryFactory } = createTelemetryDouble();
      installTelemetryTestRuntime(pi, { telemetryFactory });

      await emit(handlers, 'turn_end', {
        turnIndex: 4,
        toolResults: [],
        message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.6', usage, ...message },
      });

      return records;
    }

    // The regression this guards: a dropped WebSocket produced only
    // `finish_reasons=error` with no error level and no message anywhere.
    it('reports a provider transport failure as an error with its diagnostics', async () => {
      const records = await emitTurn({
        stopReason: 'error',
        errorMessage: 'WebSocket error',
        diagnostics: [
          {
            type: 'provider_transport_failure',
            timestamp: 1,
            error: { name: 'Error', message: 'WebSocket error', code: 'ECONNRESET' },
            details: { configuredTransport: 'websocket', phase: 'after_message_stream_start' },
          },
        ],
      });

      const failure = records.find((entry) => entry.message === 'pi.turn.failed');
      expect(failure?.level).toBe('error');
      expect(failure?.attributes).toMatchObject({
        'pi.turn.index': 4,
        'gen_ai.response.finish_reasons': 'error',
        'error.type': 'ProviderError',
        'error.code': 'error',
        outcome: 'error',
      });
      expect(failure?.attributes ?? {}).not.toHaveProperty('error.message');
      expect(failure?.attributes ?? {}).not.toHaveProperty('pi.diagnostic.0.details');
    });

    it('reports an aborted turn as a warning rather than a fault', async () => {
      const records = await emitTurn({ stopReason: 'aborted', errorMessage: 'Operation aborted' });

      const failure = records.find((entry) => entry.message === 'pi.turn.failed');
      expect(failure?.level).toBe('warn');
      expect(failure?.attributes).toMatchObject({
        'error.type': 'ProviderError',
        'error.code': 'aborted',
        outcome: 'aborted',
      });
      expect(failure?.attributes ?? {}).not.toHaveProperty('error.message');
    });

    it('falls back to the raw stop reason when no message survived', async () => {
      const records = await emitTurn({ stopReason: 'error', rawStopReason: 'transport_closed' });

      expect(records.find((entry) => entry.message === 'pi.turn.failed')?.attributes).toMatchObject({
        'error.type': 'ProviderError',
        'error.code': 'error',
      });
      expect(records.find((entry) => entry.message === 'pi.turn.failed')?.attributes ?? {}).not.toHaveProperty(
        'error.message',
      );
    });

    it('leaves a successful turn with only its usage record', async () => {
      const records = await emitTurn({ stopReason: 'stop' });

      expect(records.some((entry) => entry.message === 'pi.turn.failed')).toBe(false);
      expect(records.some((entry) => entry.message === 'pi.turn.finished')).toBe(true);
    });
  });

  it('contains flush and shutdown exporter failures', async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    } as unknown as ExtensionAPI;
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const onDiagnostic = vi.fn();
    // Causes are worded distinctly from the "Doom telemetry flush failed:" prefix
    // so these assertions test the propagated cause rather than the literal label.
    vi.mocked(telemetry.flush).mockRejectedValueOnce(new Error('exporter unreachable'));
    vi.mocked(telemetry.shutdown).mockRejectedValueOnce(new Error('socket already closed'));
    installTelemetryTestRuntime(pi, { telemetryFactory, onDiagnostic });

    await expect(emit(handlers, 'agent_end', { messages: [] })).resolves.toBeUndefined();
    await expect(emit(handlers, 'session_shutdown', { reason: 'quit' })).resolves.toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('exporter unreachable'));
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining('socket already closed'));
  });

  it('keeps telemetry diagnostics off stderr when no handler is supplied', async () => {
    // The shipped entry point constructs the extension with no options. Falling
    // back to process.emitWarning writes raw text over the live TUI frame.
    const handlers = new Map<string, Handler>();
    const pi = {
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
      events: { on: vi.fn(), off: vi.fn() },
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    vi.mocked(telemetry.flush).mockRejectedValueOnce(new Error('exporter unreachable'));
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    try {
      installLogTestRuntime(pi, { telemetryFactory, env: {} });
      await expect(emit(handlers, 'agent_end', { messages: [] })).resolves.toBeUndefined();

      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });
});
