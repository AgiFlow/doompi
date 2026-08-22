import { describe, expect, it } from 'vitest';
import { createDoomVoiceToolsService } from '../src/schemas/voiceTools.ts';
import {
  createVoiceReloadHandoffStore,
  VOICE_RELOAD_HANDOFF_REGISTRY_KEY,
  VOICE_RELOAD_HANDOFF_TTL_MS,
  VoiceReloadHandoffError,
} from '../src/schemas/voiceReloadHandoff.ts';

function runtime(token: string, clock: { now: number }) {
  return { now: () => clock.now, createToken: () => token };
}

describe('voice reload handoff store', () => {
  it('crosses module accessors only after exact-generation commit and consumes once', () => {
    const clock = { now: 1_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('handoff-session');
    session.setActive(true);
    const producer = createVoiceReloadHandoffStore(runtime('committed-once', clock));
    const consumer = createVoiceReloadHandoffStore(runtime('unused', clock));
    const pending = producer.prepare(session, { operationId: 'operation-1', domains: ['alpha'] });

    expect(
      producer.commit(pending.token, {
        sessionId: session.sessionId,
        hostGeneration: 'wrong-generation',
      }),
    ).toBe(false);
    expect(pending.commit()).toBe(true);
    expect(consumer.consume(session.sessionId, pending.token)).toMatchObject({
      hostGeneration: session.hostGeneration,
      domains: ['alpha'],
    });
    expect(consumer.consume(session.sessionId, pending.token)).toBeUndefined();
    voice.dispose();
  });

  it('rejects inactive sessions and expires pending state by TTL', () => {
    const clock = { now: 2_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('expiring-session');
    const store = createVoiceReloadHandoffStore(runtime('expiring', clock));

    expect(() => store.prepare(session, { operationId: 'operation-2' })).toThrow(VoiceReloadHandoffError);
    session.setActive(true);
    const pending = store.prepare(session, { operationId: 'operation-2' });
    clock.now += VOICE_RELOAD_HANDOFF_TTL_MS;
    expect(pending.commit()).toBe(false);
    expect(store.consume(session.sessionId, pending.token)).toBeUndefined();
    voice.dispose();
  });

  it('validates mutually exclusive domain and major-mode payloads', () => {
    const clock = { now: 3_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('validated-session');
    session.setActive(true);
    const store = createVoiceReloadHandoffStore(runtime('validated', clock));

    expect(() =>
      store.prepare(session, {
        operationId: 'operation-3',
        kind: 'major-mode-switch',
        majorMode: 'minimal',
        domains: ['development'],
      }),
    ).toThrow(/cannot include domains/u);
    expect(() =>
      store.prepare(session, { operationId: 'operation-3', kind: 'domain-switch', majorMode: 'minimal' }),
    ).toThrow(/cannot include a major mode/u);
    voice.dispose();
  });

  it('requires a valid clock, identity, request, and major-mode target', () => {
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('validation-session');
    session.setActive(true);

    expect(() =>
      createVoiceReloadHandoffStore({ now: () => -1, createToken: () => 'invalid-clock' }).prepare(session, {
        operationId: 'operation',
      }),
    ).toThrow(/clock is invalid/u);

    const store = createVoiceReloadHandoffStore(runtime('validation-errors', { now: 4_000 }));
    expect(() => store.prepare({ ...session, sessionId: '' }, { operationId: 'operation' })).toThrow(/identity/u);
    expect(() => store.prepare(session, { operationId: '' })).toThrow(/request/u);
    expect(() => store.prepare(session, { operationId: 'operation', kind: 'major-mode-switch' })).toThrow(
      /require a major mode/u,
    );
    expect(() => store.accept('missing', { sessionId: '', hostGeneration: session.hostGeneration })).toThrow(
      /identity/u,
    );
    voice.dispose();
  });

  it('fences duplicate tokens and supports explicit discard exactly once', () => {
    const clock = { now: 5_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('discard-session');
    session.setActive(true);
    const store = createVoiceReloadHandoffStore(runtime('duplicate-token', clock));
    const pending = store.prepare(session, { operationId: 'operation' });

    expect(() => store.prepare(session, { operationId: 'other-operation' })).toThrow(/already active/u);
    expect(store.discard(pending.token, { sessionId: 'another-session', hostGeneration: session.hostGeneration })).toBe(
      false,
    );
    expect(pending.discard()).toBe(true);
    expect(pending.discard()).toBe(false);
    expect(pending.commit()).toBe(false);
    expect(store.discard(pending.token, { sessionId: session.sessionId, hostGeneration: session.hostGeneration })).toBe(
      false,
    );
    voice.dispose();
  });

  it('commits with explicit accept and consumes the newest matching generation', () => {
    const clock = { now: 6_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('newest-session');
    session.setActive(true);
    const firstStore = createVoiceReloadHandoffStore(runtime('newest-first', clock));
    const first = firstStore.prepare(session, { operationId: 'first', domains: ['one'] });
    expect(
      firstStore.accept(first.token, { sessionId: session.sessionId, hostGeneration: session.hostGeneration }),
    ).toMatchObject({ operationId: 'first' });
    expect(
      firstStore.accept(first.token, { sessionId: session.sessionId, hostGeneration: session.hostGeneration }),
    ).toBeUndefined();

    clock.now += 1;
    const secondStore = createVoiceReloadHandoffStore(runtime('newest-second', clock));
    const second = secondStore.prepare(session, {
      operationId: 'second',
      kind: 'major-mode-switch',
      majorMode: 'minimal',
    });
    expect(second.commit()).toBe(true);

    const consumer = createVoiceReloadHandoffStore(runtime('unused-consumer-token', clock));
    const consumedSecond = consumer.consume(session.sessionId);
    expect(consumedSecond).toMatchObject({
      operationId: 'second',
      kind: 'major-mode-switch',
      majorMode: 'minimal',
      domains: [],
    });
    consumedSecond!.domains.push('consumer-only');
    expect(consumer.consume(session.sessionId)).toMatchObject({ operationId: 'first', domains: ['one'] });
    expect(consumer.consume(session.sessionId)).toBeUndefined();
    voice.dispose();
  });

  it('rejects oversized tokens and invalid consume session ids', () => {
    const clock = { now: 7_000 };
    const voice = createDoomVoiceToolsService('voice-generation');
    const session = voice.bindSession('bounded-session');
    session.setActive(true);
    const oversizedToken = 'x'.repeat(512);
    const store = createVoiceReloadHandoffStore(runtime(oversizedToken, clock));

    expect(() => store.prepare(session, { operationId: 'bounded-operation' })).toThrow(/token is invalid/u);
    expect(() => store.consume('')).toThrow(/session id is invalid/u);
    expect(() => store.consume('x'.repeat(257))).toThrow(/session id is invalid/u);
    expect(VOICE_RELOAD_HANDOFF_REGISTRY_KEY).toContain('voice-reload-handoff.v1');
    voice.dispose();
  });
});
