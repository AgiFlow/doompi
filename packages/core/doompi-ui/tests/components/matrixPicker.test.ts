import type { SelectItem } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { markItems, toggleValue, visibleValues } from '../../src/exports/components/matrixPicker.ts';

const items: SelectItem[] = [
  { value: 'development', label: 'development' },
  { value: 'design', label: 'design' },
  { value: 'marketing', label: 'marketing' },
];

describe('matrix picker helpers', () => {
  it('adds checkboxes in multi mode only', () => {
    expect(markItems(items, ['design'], true).map((item) => item.label)).toEqual([
      '[ ] development',
      '[x] design',
      '[ ] marketing',
    ]);
  });

  it('leaves single-select rows undecorated', () => {
    // Single select is a button group: the cursor is the selection, so a
    // checkbox column would be a second, competing indicator.
    expect(markItems(items, ['design'], false)).toBe(items);
  });

  it('matches SelectList prefix filtering when placing the cursor', () => {
    // SelectList filters with value.startsWith, so a contains-style guess here
    // would put the cursor on the wrong row.
    expect(visibleValues(items, 'de')).toEqual(['development', 'design']);
    expect(visibleValues(items, 'DE')).toEqual(['development', 'design']);
    expect(visibleValues(items, 'ing')).toEqual([]);
    expect(visibleValues(items, '')).toEqual(['development', 'design', 'marketing']);
  });

  it('toggles values without disturbing the rest of the selection', () => {
    expect(toggleValue(['development'], 'design')).toEqual(['development', 'design']);
    expect(toggleValue(['development', 'design'], 'development')).toEqual(['design']);
    expect(toggleValue([], 'design')).toEqual(['design']);
  });
});
