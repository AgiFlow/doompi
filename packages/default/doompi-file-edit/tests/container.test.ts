import { describe, expect, it } from 'vitest';
import { createFileEditDependencies } from '../src/tui/fileEditDependencies';
import type { FileEditDependencies } from '../src/types';

describe('createFileEditDependencies', () => {
  it('assembles every dependency once per session', () => {
    const container = createFileEditDependencies();
    const dependencies = Object.values(container);

    expect(dependencies).toHaveLength(9);
    expect(dependencies.every((dependency) => dependency !== undefined)).toBe(true);
    // The record is the graph, so shared collaborators are shared by construction.
    expect(container.editTracker).toBeDefined();
  });

  it('returns an independent graph for another session', () => {
    expect(createFileEditDependencies().timeline).not.toBe(createFileEditDependencies().timeline);
  });

  it('substitutes an override instead of constructing the default', () => {
    const timeline = {} as FileEditDependencies['timeline'];

    expect(createFileEditDependencies({ timeline }).timeline).toBe(timeline);
  });
});
