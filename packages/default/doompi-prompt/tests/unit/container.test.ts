import { describe, expect, it } from 'vitest';
import { createPromptContainer } from '../../src/container/index.ts';
import { createRecentPrompts } from '../../src/services/recentPrompts.ts';

describe('the container', () => {
  it('builds a working store and ring by default', () => {
    const dependencies = createPromptContainer();

    expect(typeof dependencies.store.list).toBe('function');
    expect(dependencies.recent.list()).toEqual([]);
  });

  it('takes an override per dependency, so a test never touches the real prompts directory', () => {
    const recent = createRecentPrompts();
    recent.push('staged');

    const dependencies = createPromptContainer({ recent });

    expect(dependencies.recent.list()).toEqual(['staged']);
  });
});
