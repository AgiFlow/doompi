import { DOOM_BACKGROUND_WORK_CHANGED_EVENT } from '@agimon-ai/doompi-extension-contracts/background-work';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { SubagentCapabilityPolicyStore } from '../../src/schemas/team/capabilityCeiling';
import { createBackgroundWorkService } from '../../src/services/backgroundWorkService';
import { createSubagentPolicyService } from '../../src/services/subagentPolicyService';

const roots: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe('background-work Cordis service', () => {
  it('replaces providers by name and makes stale handles harmless', () => {
    const root = new Context();
    roots.push(root);
    const changed: string[] = [];
    root.on(DOOM_BACKGROUND_WORK_CHANGED_EVENT, (event) => changed.push(event.kind));
    const service = createBackgroundWorkService(root);
    const first = service.register({
      provider: 'task',
      listActiveWork: () => [{ id: 'old', sessionId: 'session-1' }],
    });
    const second = service.register({
      provider: 'task',
      listActiveWork: () => [{ id: 'new', sessionId: 'session-1' }],
    });

    first.dispose();
    second.update();
    expect(service.snapshot('session-1')).toEqual({
      items: [{ provider: 'task', id: 'new', sessionId: 'session-1' }],
      errors: [],
    });
    expect(changed).toEqual(['registered', 'registered', 'updated']);

    second.dispose();
    expect(service.snapshot()).toEqual({ items: [], errors: [] });
    expect(changed.at(-1)).toBe('unregistered');
  });

  it('isolates invalid provider snapshots as named errors', () => {
    const root = new Context();
    roots.push(root);
    const service = createBackgroundWorkService(root);
    service.register({ provider: 'broken', listActiveWork: () => [{ id: '', sessionId: 'session-1' }] });

    expect(service.snapshot()).toEqual({
      items: [],
      errors: [{ provider: 'broken', message: 'listActiveWork() returned an invalid item.' }],
    });
  });
});

describe('subagent-policy Cordis service', () => {
  it('updates and retracts only the current contribution generation', () => {
    const store = new SubagentCapabilityPolicyStore();
    const service = createSubagentPolicyService(store);
    const first = service.register({ owner: 'plan', allowedTools: ['read', 'grep'] });
    const replacement = service.register({ owner: 'plan', allowedTools: ['read'] });

    first.dispose();
    expect(store.resolve()?.allowedTools).toEqual(['read']);
    replacement.update({ owner: 'plan', allowedTools: ['read', 'grep'], denyExtensions: true });
    expect(store.resolve()).toMatchObject({ allowedTools: ['grep', 'read'], denyExtensions: true });
    replacement.dispose();
    expect(store.resolve()).toBeUndefined();
  });

  it('rejects malformed contributions and owner changes', () => {
    const service = createSubagentPolicyService(new SubagentCapabilityPolicyStore());
    expect(() => service.register({ owner: '' })).toThrow(/Invalid subagent policy/);
    const handle = service.register({ owner: 'plan', allowedTools: ['read'] });
    expect(() => handle.update({ owner: 'other', allowedTools: ['read'] })).toThrow(/Cannot change/);
  });
});
