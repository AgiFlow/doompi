import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  childProcessContextEnvironment,
  DOOM_CHILD_PROCESS_CONTEXT_ENV,
  readChildProcessContext,
  resolveRootSessionId,
  SUBAGENT_ROOT_SESSION_ENV,
} from '../src/schemas/childProcess.ts';
import {
  DelegationAcceptedSchema,
  DelegationRequestSchema,
  DelegationResultSchema,
} from '../src/schemas/delegation.ts';
import { FooterStatusItemSchema } from '../src/schemas/footer.ts';
import { LeaderBindingSchema, LeaderSourceSchema } from '../src/schemas/leader.ts';
import {
  createProtocolRuntime,
  DoomProtocolError,
  DoomProtocolValidationError,
  defineNotification,
  defineRequestReply,
  type EventBusLike,
} from '../src/schemas/protocol.ts';

class TestBus implements EventBusLike {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

const Ping = defineRequestReply({
  channels: {
    request: 'doom:test:ping:v1:request',
    response: 'doom:test:ping:v1:response',
    error: 'doom:test:ping:v1:error',
  },
  kinds: { request: 'ping.request', response: 'ping.response' },
  request: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  response: Type.Object({ value: Type.String() }, { additionalProperties: false }),
});

function runtime(bus: TestBus, source: string) {
  return createProtocolRuntime({ bus, source, sessionId: 'session-1', defaultTimeoutMs: 20 });
}

describe('protocol runtime', () => {
  it('subscribes before emitting and correlates a synchronous response', async () => {
    const bus = new TestBus();
    const dispose = runtime(bus, 'provider').provide(Ping, ({ value }) => ({ value: value.toUpperCase() }));
    await expect(runtime(bus, 'client').request(Ping, { value: 'hello' })).resolves.toEqual({ value: 'HELLO' });
    dispose();
  });

  it('rejects request and response channels from different protocols', () => {
    expect(() =>
      defineRequestReply({
        channels: {
          request: 'doom:test:alpha:v1:request',
          response: 'doom:test:beta:v1:response',
          error: 'doom:test:alpha:v1:error',
        },
        kinds: { request: 'alpha.request', response: 'alpha.response' },
        request: Type.Object({}),
        response: Type.Object({}),
      }),
    ).toThrow('Request/reply channels must share one protocol');
  });

  it('rejects invalid outbound payloads', () => {
    const bus = new TestBus();
    const Changed = defineNotification({
      channel: 'doom:test:state:v1:changed',
      kind: 'state.changed',
      payload: Type.Object({ ready: Type.Boolean() }, { additionalProperties: false }),
    });
    expect(() => runtime(bus, 'client').notify(Changed, { ready: 'yes' } as never)).toThrow(
      DoomProtocolValidationError,
    );
    expect(() => runtime(bus, 'client').notify(Changed, null as never)).toThrow(DoomProtocolValidationError);
  });

  it('strictly validates typed delegation requests and results', () => {
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-1',
        taskId: 'task-1',
        agent: 'explorer',
        prompt: 'Inspect the package',
        cwd: '/tmp',
        unexpected: true,
      }),
    ).toBe(false);
    expect(Check(DelegationAcceptedSchema, { requestId: 'request-1', unexpected: true })).toBe(false);
    expect(Check(DelegationAcceptedSchema, { requestId: 'request-1' })).toBe(true);
    expect(
      Check(DelegationResultSchema, {
        requestId: 'request-1',
        runId: 'run-1',
        status: 'running',
      }),
    ).toBe(false);
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-2',
        taskId: 'task-2',
        agent: 'schema-explorer',
        inlineAgent: { systemPrompt: '' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
      }),
    ).toBe(false);
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-3',
        taskId: 'task-3',
        agent: 'schema-explorer',
        inlineAgent: { systemPrompt: 'Inspect schemas only.' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
      }),
    ).toBe(true);
  });

  it('requires exactly one typed leader binding target', () => {
    const path = [{ key: 'p', label: 'plan' }];

    expect(
      Check(LeaderBindingSchema, {
        id: 'plan.normal',
        path,
        action: { name: 'plan.normal' },
      }),
    ).toBe(true);
    expect(
      Check(LeaderBindingSchema, {
        id: 'plan.toggle',
        path,
        command: { name: 'plan' },
      }),
    ).toBe(true);
    expect(
      Check(LeaderBindingSchema, {
        id: 'plan.mixed',
        path,
        command: { name: 'plan' },
        action: { name: 'plan.normal' },
      }),
    ).toBe(false);
    expect(Check(LeaderBindingSchema, { id: 'plan.missing', path })).toBe(false);
  });

  it('validates trusted leader source identifiers', () => {
    expect(Check(LeaderSourceSchema, '@agimon-ai/doompi-plan')).toBe(true);
    expect(Check(LeaderSourceSchema, 'unsafe source')).toBe(false);
    expect(Check(LeaderSourceSchema, '/unsafe-source')).toBe(false);
  });

  it('ignores correlated replies from an unexpected provider source', async () => {
    const bus = new TestBus();
    runtime(bus, 'rogue-provider').provide(Ping, () => ({ value: 'ROGUE' }));
    runtime(bus, 'trusted-provider').provide(Ping, () => ({ value: 'TRUSTED' }));

    await expect(
      runtime(bus, 'client').request(Ping, { value: 'hello' }, { expectedSource: 'trusted-provider' }),
    ).resolves.toEqual({ value: 'TRUSTED' });
  });

  it('preserves typed provider errors', async () => {
    const bus = new TestBus();
    runtime(bus, 'provider').provide(Ping, () => {
      throw new DoomProtocolError({ code: 'DENIED', message: 'not allowed', retryable: true });
    });
    await expect(runtime(bus, 'client').request(Ping, { value: 'hello' })).rejects.toMatchObject({
      code: 'DENIED',
      message: 'not allowed',
      retryable: true,
    });
  });

  it('maps provider failures to typed client errors', async () => {
    const bus = new TestBus();
    runtime(bus, 'provider').provide(Ping, () => {
      throw new Error('unavailable');
    });
    await expect(runtime(bus, 'client').request(Ping, { value: 'hello' })).rejects.toMatchObject({
      name: 'DoomProtocolError',
      code: 'PROVIDER_ERROR',
      message: 'unavailable',
    });
  });

  it('times out and removes response listeners', async () => {
    vi.useFakeTimers();
    const bus = new TestBus();
    const pending = runtime(bus, 'client').request(Ping, { value: 'hello' });
    const assertion = expect(pending).rejects.toBeInstanceOf(DoomProtocolError);
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(bus.listenerCount(Ping.responseChannel)).toBe(0);
    expect(bus.listenerCount(Ping.errorChannel)).toBe(0);
    vi.useRealTimers();
  });

  it('supports AbortSignal cancellation and cleanup', async () => {
    const bus = new TestBus();
    const controller = new AbortController();
    const pending = runtime(bus, 'client').request(Ping, { value: 'hello' }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(bus.listenerCount(Ping.responseChannel)).toBe(0);
  });

  it('deduplicates notification message ids within a bounded window', async () => {
    const bus = new TestBus();
    const Changed = defineNotification({
      channel: 'doom:test:state:v1:changed',
      kind: 'state.changed',
      payload: Type.Object({ ready: Type.Boolean() }),
    });
    const handler = vi.fn();
    runtime(bus, 'client').onNotification(Changed, handler);
    const message = {
      protocol: 'doom:test:state',
      version: 1,
      kind: 'state.changed',
      messageId: 'same',
      source: 'provider',
      sessionId: 'session-1',
      payload: { ready: true },
    };
    bus.emit(Changed.channel, message);
    bus.emit(Changed.channel, message);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('delivers the same notification to every independent subscriber', async () => {
    const bus = new TestBus();
    const Changed = defineNotification({
      channel: 'doom:test:subscribers:v1:changed',
      kind: 'subscribers.changed',
      payload: Type.Object({ ready: Type.Boolean() }),
    });
    const first = vi.fn();
    const second = vi.fn();
    const consumer = runtime(bus, 'client');
    consumer.onNotification(Changed, first);
    consumer.onNotification(Changed, second);

    runtime(bus, 'provider').notify(Changed, { ready: true });
    await Promise.resolve();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('isolates notifications by Pi session', async () => {
    const bus = new TestBus();
    const Changed = defineNotification({
      channel: 'doom:test:session:v1:changed',
      kind: 'session.changed',
      payload: Type.Object({ ready: Type.Boolean() }),
    });
    const handler = vi.fn();
    runtime(bus, 'session-1-consumer').onNotification(Changed, handler);
    createProtocolRuntime({ bus, source: 'session-2-provider', sessionId: 'session-2' }).notify(Changed, {
      ready: true,
    });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('strictly validates footer status payloads', () => {
    expect(
      Check(FooterStatusItemSchema, {
        id: 'agent-count',
        fullText: 'Agents ·',
        compactText: 'A ·',
        fullSegments: [{ text: 'Agents ' }, { text: '·', color: 'accent' }],
        compactSegments: [{ text: 'A ' }, { text: '·', color: 'accent' }],
        placement: 'beforeModel',
        order: 20,
      }),
    ).toBe(true);
    expect(
      Check(FooterStatusItemSchema, {
        id: 'runner-count',
        fullText: 'Runner 1',
        order: 10,
      }),
    ).toBe(false);
    expect(
      Check(FooterStatusItemSchema, {
        id: 'runner-count',
        fullText: 'Runner 1',
        compactText: 'R1',
        order: 10,
        extra: true,
      }),
    ).toBe(false);
    expect(
      Check(FooterStatusItemSchema, {
        id: 'agent-count',
        fullText: 'Agents ·',
        compactText: 'A ·',
        compactSegments: [{ text: '·', color: 'raw-red' }],
        order: 20,
      }),
    ).toBe(false);
    expect(
      Check(FooterStatusItemSchema, {
        id: 'agent-count',
        fullText: 'Agents ·',
        compactText: 'A ·',
        placement: 'runtime',
        order: 20,
      }),
    ).toBe(false);
  });

  it('resolves inherited root session lineage and falls back to the current session', () => {
    expect(resolveRootSessionId('current-session', { [SUBAGENT_ROOT_SESSION_ENV]: ' inherited-root ' })).toBe(
      'inherited-root',
    );
    expect(resolveRootSessionId(' current-session ', {})).toBe('current-session');
    expect(resolveRootSessionId('current-session', { [SUBAGENT_ROOT_SESSION_ENV]: '   ' })).toBe('current-session');
    expect(() => resolveRootSessionId(' ', {})).toThrow('non-empty current session id');
  });

  it('round-trips and strictly validates child-process context', () => {
    const environment = childProcessContextEnvironment({
      parentSessionId: 'session-1',
      workingDirectory: '/repo',
      mode: 'agiflow-dispatcher',
    });
    expect(readChildProcessContext(environment)).toEqual({
      parentSessionId: 'session-1',
      workingDirectory: '/repo',
      mode: 'agiflow-dispatcher',
    });
    expect(() =>
      readChildProcessContext({
        [DOOM_CHILD_PROCESS_CONTEXT_ENV]: JSON.stringify({ parentSessionId: 'session-1', unexpected: true }),
      }),
    ).toThrow('Invalid child process context');
  });
});
