import { describe, expect, it } from 'vitest';
import {
  parsePromptSelection,
  promptItems,
  resolvePromptSelection,
  stagedEditorText,
} from '../../../src/services/promptItems.ts';
import type { SavedPrompt } from '../../../src/types/prompt.ts';

const saved: SavedPrompt[] = [
  { name: 'review', description: 'Review the diff', text: 'Review the diff carefully' },
  { name: 'ship', description: '', text: 'Ship it\nnow' },
];

describe('picker rows', () => {
  it('lists staged prompts before saved ones', () => {
    const items = promptItems(['newest', 'older'], saved);

    expect(items.map((item) => item.value)).toEqual(['recent:0', 'recent:1', 'saved:review', 'saved:ship']);
    expect(items[0]).toEqual({ value: 'recent:0', label: 'newest', description: 'staged this session' });
  });

  it('labels a saved prompt with the slash command it becomes', () => {
    const items = promptItems([], saved);

    expect(items[0]?.label).toBe('/review');
    expect(items[0]?.description).toBe('Review the diff');
  });

  it('describes a saved prompt from its body when it has no description', () => {
    expect(promptItems([], saved)[1]?.description).toBe('Ship it');
  });

  it('shows a single-line preview for a multi-line staged prompt', () => {
    expect(promptItems(['first line\nsecond line'], [])[0]?.label).toBe('first line');
  });
});

describe('resolving a picked row', () => {
  it('reads a staged prompt back by position', () => {
    expect(resolvePromptSelection('recent:1', ['newest', 'older'], saved)).toBe('older');
  });

  it('reads a saved prompt back by name', () => {
    expect(resolvePromptSelection('saved:ship', [], saved)).toBe('Ship it\nnow');
  });

  it('returns nothing for a row that no longer exists', () => {
    expect(resolvePromptSelection('recent:9', ['only'], saved)).toBeUndefined();
    expect(resolvePromptSelection('saved:gone', [], saved)).toBeUndefined();
    expect(resolvePromptSelection('recent:x', ['only'], saved)).toBeUndefined();
  });

  it('returns nothing for a value it did not write', () => {
    expect(parsePromptSelection('other:1')).toBeUndefined();
    expect(resolvePromptSelection('other:1', ['only'], saved)).toBeUndefined();
  });
});

describe('staging into the editor', () => {
  it('replaces an empty draft', () => {
    expect(stagedEditorText('   ', 'chosen')).toBe('chosen');
  });

  it('appends after an existing draft instead of discarding it', () => {
    expect(stagedEditorText('draft  \n', 'chosen')).toBe('draft\nchosen');
  });
});
