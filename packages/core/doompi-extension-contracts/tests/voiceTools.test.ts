import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomVoiceToolsService,
  DOOM_VOICE_TOOLS_SERVICE,
  readDoomVoiceToolsService,
  requireDoomVoiceToolsService,
  VOICE_FACADE_TOOL_NAMES,
  VOICE_MODE_TOOL_NAMES,
  VOICE_NARRATE_TOOL_NAME,
  VOICE_TOOL_MAX_BATCH_ITEMS,
  VOICE_TOOL_MAX_SCHEMA_BYTES,
  VoiceToolError,
  type DoomVoiceToolsService,
  type VoiceToolDefinition,
  type VoiceToolSessionHandle,
} from '../src/schemas/voiceTools.ts';

const emptySchema = Type.Object({}, { additionalProperties: false });

function definition(
  name: string,
  execute: VoiceToolDefinition['execute'] = async () => ({ ok: true }),
  source = '@test/voice',
  id = `${name}-id`,
): VoiceToolDefinition {
  return {
    descriptor: {
      source,
      id,
      name,
      label: name,
      description: `Description for ${name}`,
      order: 1,
      inputSchema: emptySchema,
      resultSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
    },
    execute,
  };
}

describe('Doom voice-tools Cordis service', () => {
  it('keeps the façades distinct from the standalone narration tool', () => {
    expect(VOICE_FACADE_TOOL_NAMES).toEqual(['describe_voice_tools', 'use_voice_tools']);
    expect(VOICE_NARRATE_TOOL_NAME).toBe('narrate');
    expect(VOICE_MODE_TOOL_NAMES).toEqual(['describe_voice_tools', 'use_voice_tools', 'narrate']);
  });

  it('keeps live registrations local to their provider-owned service', () => {
    const first = createDoomVoiceToolsService('voice-generation-a');
    const second = createDoomVoiceToolsService('voice-generation-b');
    first.register(definition('local'));
    const firstSession = first.bindSession('session-a');
    const secondSession = second.bindSession('session-b');

    expect(firstSession.describe().tools.map(({ name }) => name)).toEqual(['local']);
    expect(secondSession.describe().tools).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it('replaces one owner/id atomically and fences stale disposal', async () => {
    const service = createDoomVoiceToolsService<{ owner: string }>('voice-generation');
    const oldExecute = vi.fn(async () => ({ ok: true }));
    const newExecute = vi.fn(async () => ({ ok: true }));
    const original = service.register(definition('replaceable', oldExecute));
    const replacement = service.register(definition('replaceable', newExecute));
    const session = service.bindSession('voice-session', { owner: 'host' });
    session.setActive(true);

    original.dispose();
    const catalog = session.describe();
    expect(catalog.tools.map(({ name }) => name)).toEqual(['replaceable']);
    const result = await session.executeBatch(
      { catalogToken: catalog.catalogToken, calls: [{ name: 'replaceable', input: {} }] },
      { owner: 'host' },
    );
    expect(result.status).toBe('completed');
    expect(oldExecute).not.toHaveBeenCalled();
    expect(newExecute).toHaveBeenCalledOnce();

    replacement.dispose();
    expect(session.describe().tools).toEqual([]);
    service.dispose();
  });

  it('reports conflicting names owned by different registrations', () => {
    const service = createDoomVoiceToolsService('voice-generation');
    service.register(definition('conflict', undefined, '@test/first', 'first'));
    service.register({
      ...definition('conflict', undefined, '@test/second', 'second'),
      descriptor: {
        ...definition('conflict', undefined, '@test/second', 'second').descriptor,
        description: 'A different contract.',
      },
    });
    const session = service.bindSession('voice-session');

    expect(session.describe().tools).toEqual([]);
    expect(session.describe().conflicts[0]?.claims).toHaveLength(2);
    service.dispose();
  });

  it('preflights input and validates output schemas', async () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const execute = vi.fn(async () => ({ ok: 'not-a-boolean' }));
    service.register({
      ...definition('validated', execute),
      descriptor: {
        ...definition('validated').descriptor,
        inputSchema: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
      },
    });
    const session = service.bindSession('voice-session');
    session.setActive(true);
    const token = session.describe().catalogToken;

    const invalidInput = await session.executeBatch(
      { catalogToken: token, calls: [{ name: 'validated', input: { value: 'wrong' } }] },
      undefined,
    );
    expect(invalidInput.status).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();

    const invalidOutput = await session.executeBatch(
      { catalogToken: session.describe().catalogToken, calls: [{ name: 'validated', input: { value: 1 } }] },
      undefined,
    );
    expect(invalidOutput.results[0]?.error?.code).toBe('VOICE_TOOL_INVALID_RESULT');
    service.dispose();
  });

  it('notifies session observers across bind and disposal', () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const changed = vi.fn();
    const unsubscribe = service.subscribeSession('voice-session', changed);
    const session = service.bindSession('voice-session');
    session.dispose();

    expect(changed.mock.calls.map(([value]) => value?.sessionId)).toEqual([undefined, 'voice-session', undefined]);
    unsubscribe();
    service.dispose();
  });

  it('rejects schemas over the bounded schema size', () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const oversized = 'x'.repeat(VOICE_TOOL_MAX_SCHEMA_BYTES);
    expect(() =>
      service.register({
        ...definition('oversized'),
        descriptor: { ...definition('oversized').descriptor, inputSchema: { type: 'string', description: oversized } },
      }),
    ).toThrow(/schema exceeds/u);
    service.dispose();
  });

  it('is discoverable only while its Cordis provider fiber is live', async () => {
    const root = new Context();
    const service = createDoomVoiceToolsService('voice-generation');
    const fiber = root.plugin((context) => context.provide(DOOM_VOICE_TOOLS_SERVICE, service));
    await fiber.await();

    expect(readDoomVoiceToolsService(root)).toBe(service);
    expect(requireDoomVoiceToolsService(root)).toBe(service);
    await fiber.dispose();
    expect(readDoomVoiceToolsService(root)).toBeUndefined();
    expect(() => requireDoomVoiceToolsService(root)).toThrow('Doom voice tools are unavailable.');
    await root.fiber.dispose();
  });

  it('validates service, descriptor, schema, and JSON boundaries', () => {
    expect(() => createDoomVoiceToolsService('')).toThrowError(
      expect.objectContaining({ code: 'VOICE_TOOL_INVALID_REQUEST' }),
    );
    expect(() => createDoomVoiceToolsService('voice\ngeneration')).toThrowError(
      expect.objectContaining({ code: 'VOICE_TOOL_INVALID_REQUEST' }),
    );

    const service = createDoomVoiceToolsService('voice-generation');
    expect(() =>
      service.register({
        ...definition('invalid'),
        descriptor: { ...definition('invalid').descriptor, name: 'INVALID' },
      }),
    ).toThrow(/Invalid voice tool descriptor/u);
    expect(() =>
      service.register({
        ...definition('primitive_schema'),
        descriptor: { ...definition('primitive_schema').descriptor, inputSchema: 'string' as never },
      }),
    ).toThrow(/schemas must be JSON objects/u);

    const cyclicSchema: Record<string, unknown> = { type: 'object' };
    cyclicSchema.self = cyclicSchema;
    expect(() =>
      service.register({
        ...definition('cyclic_schema'),
        descriptor: { ...definition('cyclic_schema').descriptor, inputSchema: cyclicSchema as never },
      }),
    ).toThrow(/Cyclic JSON/u);
    expect(() =>
      service.register({
        ...definition('unsupported_schema'),
        descriptor: { ...definition('unsupported_schema').descriptor, inputSchema: new Date() as never },
      }),
    ).toThrow(/Only JSON objects/u);
    service.dispose();
  });

  it('filters, orders, and scopes catalog entries by session', () => {
    const service = createDoomVoiceToolsService('voice-generation');
    service.register({
      ...definition('zeta'),
      descriptor: { ...definition('zeta').descriptor, order: 2 },
    });
    service.register(
      {
        ...definition('alpha'),
        descriptor: { ...definition('alpha').descriptor, order: 1 },
      },
      { sessionId: 'target-session', context: { source: 'registration' } },
    );
    service.register(definition('private_tool'), { sessionId: 'other-session' });
    const target = service.bindSession('target-session');
    const other = service.bindSession('other-session');

    expect(target.describe().tools.map(({ name }) => name)).toEqual(['alpha', 'zeta']);
    expect(other.describe().tools.map(({ name }) => name)).toEqual(['private_tool', 'zeta']);
    expect(target.describe({ names: ['zeta', 'missing', 'alpha', 'zeta'] })).toMatchObject({
      tools: [{ name: 'zeta' }, { name: 'alpha' }],
      unknownNames: ['missing'],
    });
    expect(() => target.describe({ names: ['INVALID'] })).toThrowError(
      expect.objectContaining({ code: 'VOICE_TOOL_INVALID_REQUEST' }),
    );
    service.dispose();
  });

  it('rejects stale, inactive, missing, conflicting, and oversized batches before execution', async () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const execute = vi.fn(async () => ({ ok: true }));
    service.register(definition('valid', execute));
    const session = service.bindSession('voice-session');
    const inactive = await session.executeBatch(
      { catalogToken: 'stale-token', calls: [{ name: 'valid', input: {} }] },
      undefined,
    );
    expect(inactive.errors?.map(({ code }) => code)).toEqual(['VOICE_TOOL_STALE_CATALOG', 'VOICE_TOOL_INACTIVE']);

    session.setActive(true);
    const token = session.describe().catalogToken;
    const missing = await session.executeBatch(
      {
        catalogToken: token,
        calls: [
          { name: 'valid', input: {} },
          { name: 'missing', input: {} },
        ],
      },
      undefined,
    );
    expect(missing.results.map(({ status }) => status)).toEqual(['not_executed', 'preflight_failed']);
    expect(missing.results[1]?.error?.code).toBe('VOICE_TOOL_NOT_FOUND');
    expect(execute).not.toHaveBeenCalled();

    service.register(definition('conflict_batch', undefined, '@test/first', 'first'));
    service.register({
      ...definition('conflict_batch', undefined, '@test/second', 'second'),
      descriptor: {
        ...definition('conflict_batch', undefined, '@test/second', 'second').descriptor,
        label: 'Different label',
      },
    });
    const conflict = await session.executeBatch(
      { catalogToken: session.describe().catalogToken, calls: [{ name: 'conflict_batch', input: {} }] },
      undefined,
    );
    expect(conflict.results[0]?.error?.code).toBe('VOICE_TOOL_NAME_CONFLICT');

    const calls = Array.from({ length: VOICE_TOOL_MAX_BATCH_ITEMS + 1 }, () => ({ name: 'valid', input: {} }));
    const oversized = await session.executeBatch({ catalogToken: session.describe().catalogToken, calls }, undefined);
    expect(oversized.errors?.[0]?.code).toBe('VOICE_TOOL_INVALID_REQUEST');
    service.dispose();
  });

  it('replays terminal operations and stops remaining calls after a reload result', async () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const execute = vi.fn(async () => ({ ok: true }));
    service.register(definition('cached', execute));
    service.register({
      descriptor: {
        ...definition('reload').descriptor,
        resultSchema: Type.Object(
          { ok: Type.Boolean(), stopBatch: Type.Literal('session-reload') },
          { additionalProperties: false },
        ),
      },
      execute: async () => ({ ok: true, stopBatch: 'session-reload' }),
    });
    const later = vi.fn(async () => ({ ok: true }));
    service.register(definition('later', later));
    const session = service.bindSession('voice-session');
    session.setActive(true);

    const cachedInput = { catalogToken: session.describe().catalogToken, calls: [{ name: 'cached', input: {} }] };
    const first = await session.useVoiceTools(cachedInput, undefined, { operationId: 'stable-operation' });
    const replay = await session.executeBatch(cachedInput, undefined, { operationId: 'stable-operation' });
    expect(replay).toEqual(first);
    expect(replay).not.toBe(first);
    expect(execute).toHaveBeenCalledOnce();

    const stopped = await session.executeBatch(
      {
        catalogToken: session.describe().catalogToken,
        calls: [
          { name: 'reload', input: {} },
          { name: 'later', input: {} },
        ],
      },
      undefined,
    );
    expect(stopped.status).toBe('stopped');
    expect(stopped.results.map(({ status }) => status)).toEqual(['completed', 'not_executed']);
    expect(stopped.results[1]?.error?.code).toBe('VOICE_TOOL_BATCH_STOPPED');
    expect(later).not.toHaveBeenCalled();
    service.dispose();
  });

  it('normalizes execution failures and honours caller cancellation and timeout', async () => {
    const service = createDoomVoiceToolsService('voice-generation');
    service.register(definition('throws', async () => Promise.reject(new Error('private failure'))));
    service.register(
      definition('typed_error', async () => Promise.reject(new VoiceToolError('VOICE_TOOL_ABORTED', 'gone', true))),
    );
    service.register({
      ...definition('timeout', async () => new Promise(() => undefined)),
      descriptor: { ...definition('timeout').descriptor, timeoutMs: 1 },
    });
    service.register(definition('cancelled', async () => new Promise(() => undefined)));
    const session = service.bindSession('voice-session');
    session.setActive(true);

    const execute = (name: string, signal?: AbortSignal) =>
      session.executeBatch(
        { catalogToken: session.describe().catalogToken, calls: [{ name, input: {} }] },
        undefined,
        signal ? { signal } : {},
      );
    expect((await execute('throws')).results[0]?.error).toMatchObject({
      code: 'VOICE_TOOL_EXECUTION_FAILED',
      message: 'Voice tool execution failed.',
    });
    expect((await execute('typed_error')).results[0]).toMatchObject({
      status: 'cancelled',
      error: { code: 'VOICE_TOOL_ABORTED', retryable: true },
    });
    expect((await execute('timeout')).results[0]?.error?.code).toBe('VOICE_TOOL_TIMEOUT');

    const controller = new AbortController();
    const cancelled = execute('cancelled', controller.signal);
    controller.abort('caller stopped');
    expect((await cancelled).results[0]).toMatchObject({ status: 'cancelled', error: { code: 'VOICE_TOOL_ABORTED' } });
    service.dispose();
  });

  it('fences session and registration changes that occur during execution', async () => {
    const runScenario = async (
      name: string,
      mutate: (service: DoomVoiceToolsService, session: VoiceToolSessionHandle) => void,
    ) => {
      const service = createDoomVoiceToolsService('voice-generation');
      let session!: ReturnType<typeof service.bindSession>;
      service.register(
        definition(name, async () => {
          mutate(service, session);
          return { ok: true };
        }),
      );
      session = service.bindSession('voice-session');
      session.setActive(true);
      const result = await session.executeBatch(
        { catalogToken: session.describe().catalogToken, calls: [{ name, input: {} }] },
        undefined,
      );
      service.dispose();
      return result.results[0]?.error?.code;
    };

    expect(await runScenario('becomes_inactive', (_service, session) => session.setActive(false))).toBe(
      'VOICE_TOOL_INACTIVE',
    );
    expect(await runScenario('session_disposed', (_service, session) => session.dispose())).toBe(
      'VOICE_TOOL_SESSION_SHUTDOWN',
    );
    expect(await runScenario('catalog_changes', (service) => service.register(definition('new_registration')))).toBe(
      'VOICE_TOOL_STALE_CATALOG',
    );
    expect(
      await runScenario('becomes_conflict', (service) =>
        service.register({
          ...definition('becomes_conflict', undefined, '@test/conflict', 'conflict'),
          descriptor: {
            ...definition('becomes_conflict', undefined, '@test/conflict', 'conflict').descriptor,
            description: 'Conflicting contract',
          },
        }),
      ),
    ).toBe('VOICE_TOOL_STALE_CATALOG');
  });

  it('makes provider, session, subscription, and registration disposal idempotent', async () => {
    const service = createDoomVoiceToolsService('voice-generation');
    const registration = service.register(definition('disposable'));
    const listener = vi.fn();
    const unsubscribe = service.subscribeSession('voice-session', listener);
    const session = service.bindSession('voice-session');
    expect(service.readSession('voice-session')).toBe(session);
    expect(() => service.bindSession('voice-session')).toThrow(/already bound/u);
    session.dispose();
    session.dispose();
    session.setActive(true);
    expect(session.subscribe(vi.fn())()).toBeUndefined();
    expect(
      (await session.executeBatch({ catalogToken: 'old', calls: [{ name: 'disposable', input: {} }] }, undefined))
        .errors?.[0]?.code,
    ).toBe('VOICE_TOOL_SESSION_SHUTDOWN');
    unsubscribe();
    unsubscribe();
    registration.dispose();
    registration.dispose();
    service.dispose();
    service.dispose();
    expect(service.subscribeSession('after-dispose', vi.fn())()).toBeUndefined();
    expect(() => service.register(definition('after_dispose'))).toThrow(/disposed/u);
    expect(() => service.bindSession('after-dispose')).toThrow(/disposed/u);
  });
});
