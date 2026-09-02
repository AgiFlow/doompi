import { describe, expect, it, vi } from 'vitest';
import {
  canSaveDraft,
  filterPrompts,
  promptFrame,
  commitDraft,
  draftOf,
  EMPTY_DRAFT,
  type PromptsMutationApi,
  renamedFrom,
} from '../../src/web/promptsActions.ts';

function api(overrides: Partial<PromptsMutationApi> = {}): PromptsMutationApi {
  return {
    save: overrides.save ?? vi.fn(async () => undefined),
    remove: overrides.remove ?? vi.fn(async () => undefined),
  };
}

describe('drafts', () => {
  it('starts empty for a new prompt', () => {
    expect(EMPTY_DRAFT).toEqual({ name: '', text: '', original: '' });
    expect(canSaveDraft(EMPTY_DRAFT)).toBe(false);
  });

  it('remembers the name it is replacing when editing', () => {
    expect(draftOf({ name: 'review', description: 'r', text: 'body' })).toEqual({
      name: 'review',
      text: 'body',
      original: 'review',
    });
  });

  it('refuses a draft missing a name or a body', () => {
    expect(canSaveDraft({ name: '  ', text: 'body', original: '' })).toBe(false);
    expect(canSaveDraft({ name: 'review', text: '  ', original: '' })).toBe(false);
    expect(canSaveDraft({ name: 'review', text: 'body', original: '' })).toBe(true);
  });

  it('detects a rename, and only a rename', () => {
    expect(renamedFrom({ name: 'new', text: 'x', original: 'old' })).toBe('old');
    expect(renamedFrom({ name: 'same', text: 'x', original: 'same' })).toBeUndefined();
    expect(renamedFrom({ name: 'fresh', text: 'x', original: '' })).toBeUndefined();
  });
});

describe('committing a draft', () => {
  it('writes a new prompt without deleting anything', async () => {
    const mutations = api();

    await expect(commitDraft({ name: 'review', text: 'body', original: '' }, mutations)).resolves.toBeUndefined();

    expect(mutations.save).toHaveBeenCalledWith('review', 'body');
    expect(mutations.remove).not.toHaveBeenCalled();
  });

  it('trims the name before writing', async () => {
    const mutations = api();

    await commitDraft({ name: '  review  ', text: 'body', original: '' }, mutations);

    expect(mutations.save).toHaveBeenCalledWith('review', 'body');
  });

  it('removes the old template after a rename', async () => {
    const mutations = api();

    await expect(commitDraft({ name: 'audit', text: 'body', original: 'review' }, mutations)).resolves.toBeUndefined();

    expect(mutations.remove).toHaveBeenCalledWith('review');
  });

  it('keeps the original when the write failed', async () => {
    const mutations = api({ save: vi.fn(async () => ({ error: 'disk full' })) });

    await expect(commitDraft({ name: 'audit', text: 'body', original: 'review' }, mutations)).resolves.toEqual({
      error: 'disk full',
    });

    expect(mutations.remove).not.toHaveBeenCalled();
  });

  it('reports a rename that left the old template behind', async () => {
    const mutations = api({ remove: vi.fn(async () => ({ error: 'read-only' })) });

    await expect(commitDraft({ name: 'audit', text: 'body', original: 'review' }, mutations)).resolves.toEqual({
      error: 'Saved /audit, but /review could not be removed: read-only',
    });
  });
});

describe('sending and filtering', () => {
  const prompts = [
    { name: 'review', description: 'Review the diff', text: 'a' },
    { name: 'ship', description: 'Release it', text: 'b' },
  ];

  it('builds the frame the cockpit submits', () => {
    expect(promptFrame('body')).toEqual({ type: 'prompt', message: 'body' });
  });

  it('matches on the name and on the description', () => {
    expect(filterPrompts(prompts, 'rev').map((prompt) => prompt.name)).toEqual(['review']);
    expect(filterPrompts(prompts, 'release').map((prompt) => prompt.name)).toEqual(['ship']);
  });

  it('ignores case and surrounding space, and keeps everything for an empty filter', () => {
    expect(filterPrompts(prompts, '  SHIP ').map((prompt) => prompt.name)).toEqual(['ship']);
    expect(filterPrompts(prompts, '   ')).toHaveLength(2);
  });

  it('answers nothing when no entry matches', () => {
    expect(filterPrompts(prompts, 'zzz')).toEqual([]);
  });
});
