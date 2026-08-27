import { describe, expect, it } from 'vitest';
import { createFileEditContainer } from '../src/container/index.ts';
import type { FileEditDependencies } from '../src/types/index.ts';

describe('createFileEditContainer', () => {
  it('assembles every dependency once per session', () => {
    const container = createFileEditContainer();
    const dependencies = Object.values(container);

    expect(dependencies).toHaveLength(9);
    expect(dependencies.every((dependency) => dependency !== undefined)).toBe(true);
    // The record is the graph, so shared collaborators are shared by construction.
    expect(container.editTracker).toBeDefined();
  });

  it('returns an independent graph for another session', () => {
    expect(createFileEditContainer().timeline).not.toBe(createFileEditContainer().timeline);
  });

  it('substitutes an override instead of constructing the default', () => {
    const timeline = {} as FileEditDependencies['timeline'];

    expect(createFileEditContainer({ timeline }).timeline).toBe(timeline);
  });
});
