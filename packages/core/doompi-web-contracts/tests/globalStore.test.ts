import { describe, expect, it } from 'vitest';
import { defineGlobalStore } from '../src/services/globalStore.ts';

describe('defineGlobalStore', () => {
  it('shares one reactive value and resets it to the original value', () => {
    const activeSession = defineGlobalStore<string | null>(null);
    let published = 0;
    const subscription = activeSession.store.subscribe(() => {
      published += 1;
    });

    activeSession.update(() => 'session-a');
    activeSession.update((current) => current);
    expect(activeSession.store.state).toBe('session-a');
    expect(published).toBe(1);

    activeSession.reset();
    activeSession.reset();
    expect(activeSession.store.state).toBeNull();
    expect(published).toBe(2);
    subscription.unsubscribe();
  });
});
