import { describe, expect, it } from 'vitest';

import { defineWorkspaceStore } from '../../src/web/models/workspaceStore';

interface DemoWorkspace {
  branches: string[];
  checkedOut: string | undefined;
}

const EMPTY: DemoWorkspace = { branches: [], checkedOut: undefined };

describe('defineWorkspaceStore', () => {
  it('answers one shared empty record for null and unknown workspaces', () => {
    const demo = defineWorkspaceStore<DemoWorkspace>(EMPTY);
    expect(demo.select(demo.store.state, null)).toBe(EMPTY);
    expect(demo.select(demo.store.state, 'ghost')).toBe(EMPTY);
    expect(demo.select(demo.store.state, null)).toBe(demo.select(demo.store.state, 'ghost'));
  });

  it('updates one workspace without touching the others and drops it whole', () => {
    const demo = defineWorkspaceStore<DemoWorkspace>(EMPTY);
    demo.update('w1', (current) => ({ ...current, branches: ['main'] }));
    demo.update('w2', (current) => ({ ...current, checkedOut: 'trunk' }));
    expect(demo.select(demo.store.state, 'w1')).toEqual({ branches: ['main'], checkedOut: undefined });
    expect(demo.select(demo.store.state, 'w2')).toEqual({ branches: [], checkedOut: 'trunk' });

    demo.drop('w1');
    expect(demo.store.state.w1).toBeUndefined();
    expect(demo.select(demo.store.state, 'w1')).toBe(EMPTY);
    expect(demo.select(demo.store.state, 'w2').checkedOut).toBe('trunk');

    demo.reset();
    expect(demo.store.state).toEqual({});
  });

  it('publishes nothing when an updater returns the current record or a drop finds nothing', () => {
    const demo = defineWorkspaceStore<DemoWorkspace>(EMPTY);
    let published = 0;
    const subscription = demo.store.subscribe(() => {
      published += 1;
    });
    demo.update('w1', (current) => current);
    demo.drop('w1');
    expect(published).toBe(0);
    demo.update('w1', (current) => ({ ...current, branches: ['main'] }));
    expect(published).toBe(1);
    subscription.unsubscribe();
  });
});
