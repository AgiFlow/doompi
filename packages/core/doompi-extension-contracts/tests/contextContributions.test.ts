import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  DOOM_CONTEXT_CONTRIBUTIONS_SERVICE,
  createDoomContextContributionsService,
  readDoomContextContributions,
  requireDoomContextContributions,
} from '../src/exports/contextContributions.ts';

describe('Doom context contributions', () => {
  it('orders snapshots and isolates omitted and failed contributors', () => {
    const service = createDoomContextContributionsService('session-1');
    service.register({ source: 'team', id: 'state', label: 'Team', order: 200, snapshot: () => 'team text' });
    service.register({ source: 'task', id: 'state', label: 'Tasks', order: 100, snapshot: () => 'task text' });
    service.register({ source: 'idle', id: 'state', label: 'Idle', order: 50, snapshot: () => undefined });
    service.register({
      source: 'broken',
      id: 'state',
      label: 'Broken',
      order: 150,
      snapshot: () => {
        throw new Error('snapshot failed');
      },
    });

    expect(service.snapshot()).toEqual({
      entries: [
        { source: 'task', id: 'state', label: 'Tasks', order: 100, text: 'task text' },
        { source: 'team', id: 'state', label: 'Team', order: 200, text: 'team text' },
      ],
      errors: [{ source: 'broken', id: 'state', label: 'Broken', order: 150, message: 'snapshot failed' }],
    });
  });

  it('rejects duplicate active identities and permits replacement after idempotent disposal', () => {
    const service = createDoomContextContributionsService('session-1');
    const snapshot = vi.fn(() => 'first');
    const registration = service.register({ source: 'task', id: 'state', label: 'Tasks', order: 100, snapshot });

    expect(() =>
      service.register({ source: 'task', id: 'state', label: 'Replacement', order: 0, snapshot: () => 'second' }),
    ).toThrow('already registered: task/state');
    registration.dispose();
    registration.dispose();
    expect(service.snapshot()).toEqual({ entries: [], errors: [] });

    service.register({ source: 'task', id: 'state', label: 'Replacement', order: 0, snapshot: () => 'second' });
    expect(service.snapshot().entries).toEqual([
      { source: 'task', id: 'state', label: 'Replacement', order: 0, text: 'second' },
    ]);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('validates every registration field and normalizes non-Error snapshot failures', () => {
    expect(() => createDoomContextContributionsService('')).toThrow('require a session generation');
    const service = createDoomContextContributionsService('session-1');
    const valid = { source: 'source', id: 'id', label: 'Label', order: 1, snapshot: () => 'text' };
    for (const contribution of [
      { ...valid, source: ' ' },
      { ...valid, id: '\t' },
      { ...valid, label: '\n' },
      { ...valid, order: Number.NaN },
      { ...valid, order: Number.POSITIVE_INFINITY },
      { ...valid, snapshot: 'text' },
    ]) {
      expect(() => service.register(contribution as never)).toThrow();
    }
    service.register({ ...valid, snapshot: () => 1 as never });
    service.register({
      source: 'source',
      id: 'second',
      label: 'Second',
      order: 1,
      snapshot: () => {
        throw 'failed';
      },
    });
    expect(service.snapshot().errors.map(({ message }) => message)).toEqual([
      'Snapshot returned a non-string value.',
      'failed',
    ]);
  });

  it('uses source and id as deterministic tie breakers for equal order values', () => {
    const service = createDoomContextContributionsService('session-1');
    for (const [source, id] of [
      ['b', 'b'],
      ['a', 'b'],
      ['a', 'a'],
    ]) {
      service.register({ source, id, label: `${source}/${id}`, order: 1, snapshot: () => `${source}/${id}` });
    }
    expect(service.snapshot().entries.map(({ text }) => text)).toEqual(['a/a', 'a/b', 'b/b']);
  });

  it('publishes and removes the broker with a provider fiber', async () => {
    const root = new Context();
    const service = createDoomContextContributionsService('session-1');
    const fiber = root.plugin((context) => context.provide(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE, service));
    await fiber.await();

    expect(readDoomContextContributions(root)).toBe(service);
    expect(requireDoomContextContributions(root)).toBe(service);
    await fiber.dispose();
    expect(readDoomContextContributions(root)).toBeUndefined();
    expect(() => requireDoomContextContributions(root)).toThrow('Doom context contributions are unavailable');
    await root.fiber.dispose();
  });
});
