import { describe, expect, it, vi } from 'vitest';
import { defineMinorMode } from '../src/services/modeDefinition';

interface Runtime {
  active: boolean;
  flavor: string;
}
const mode = defineMinorMode<Runtime>({
  descriptor: {
    source: '@test/mode',
    id: 'review',
    label: 'Review',
    description: 'Review the current file.',
    order: 10,
    actions: [
      {
        id: 'enter',
        label: 'Enter',
        description: 'Enter a review flavor.',
        contexts: ['tui', 'headless'],
        parameters: [
          {
            name: 'flavor',
            label: 'Flavor',
            kind: 'enum',
            required: true,
            choices: [
              { value: 'brief', label: 'Brief' },
              { value: 'deep', label: 'Deep' },
            ],
          },
        ],
      },
      { id: 'exit', label: 'Exit', description: 'Leave review.', contexts: ['tui', 'headless'], parameters: [] },
    ],
  },
  state(runtime) {
    return {
      activation: runtime.active ? 'active' : 'inactive',
      condition: 'ready',
      ...(runtime.active ? { detail: runtime.flavor } : {}),
      actions: [
        { id: 'enter', enabled: true },
        { id: 'exit', enabled: runtime.active },
      ],
    };
  },
  handleAction(runtime, actionId, args) {
    if (actionId === 'enter') {
      if (args.flavor !== 'brief' && args.flavor !== 'deep') throw new Error('Valid flavor required.');
      runtime.active = true;
      runtime.flavor = args.flavor;
      return { message: `Entered ${args.flavor}.` };
    }
    if (actionId === 'exit') {
      runtime.active = false;
      return { message: 'Exited.' };
    }
    throw new Error(`Unknown action: ${actionId}`);
  },
});

describe('defineMinorMode', () => {
  it('shares an arbitrary action descriptor and publishes runtime state after actions', async () => {
    const owners = [0, 1].map(() => {
      const publish = vi.fn();
      const owner = mode.createOwner({ active: false, flavor: 'brief' });
      owner.attach({ getState: owner.state, publish, dispose: vi.fn() });
      return { owner, publish };
    });
    expect(owners[0]!.owner.definition.descriptor).toBe(owners[1]!.owner.definition.descriptor);
    for (const { owner, publish } of owners) {
      await expect(
        owner.definition.handleAction('enter', { flavor: 'deep' }, { signal: new AbortController().signal }),
      ).resolves.toEqual({ message: 'Entered deep.' });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ activation: 'active', detail: 'deep' }));
      await owner.definition.handleAction('exit', {}, { signal: new AbortController().signal });
      expect(owner.state().activation).toBe('inactive');
    }
  });

  it('rejects aborted actions before calling feature behavior', async () => {
    const owner = mode.createOwner({ active: false, flavor: 'brief' });
    const signal = new AbortController();
    signal.abort();
    await expect(
      owner.definition.handleAction('enter', { flavor: 'deep' }, { signal: signal.signal }),
    ).rejects.toThrow();
    expect(owner.state().activation).toBe('inactive');
  });

  it('notifies observers and the attached catalog once, and releases them independently', async () => {
    const owner = mode.createOwner({ active: false, flavor: 'brief' });
    const observer = vi.fn();
    const publish = vi.fn();
    const unsubscribe = owner.subscribe(observer);
    owner.attach({ getState: () => owner.state(), publish, dispose: vi.fn() });
    await owner.definition.handleAction('enter', { flavor: 'brief' }, { signal: new AbortController().signal });
    expect(observer).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    owner.detach();
    owner.publish();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
    unsubscribe();
    owner.publish();
    expect(observer).toHaveBeenCalledTimes(2);
  });
});

it('preserves the complete typed execution context for a mode action', async () => {
  type Execution = { signal: AbortSignal; context: { sessionId: string }; operationId: string };
  const seen: Execution[] = [];
  const typed = defineMinorMode<Runtime, Execution>({
    descriptor: mode.descriptor,
    state: () => ({ activation: 'inactive', condition: 'ready', actions: [] }),
    handleAction(_runtime, _action, _args, execution) {
      seen.push(execution);
    },
  });
  const execution: Execution = { signal: new AbortController().signal, context: { sessionId: 's' }, operationId: 'op' };
  const owner = typed.createOwner({} as Runtime);
  await owner.definition.handleAction('enter', {}, execution);
  expect(seen).toEqual([execution]);
  expect(seen[0]).toBe(execution);
});
