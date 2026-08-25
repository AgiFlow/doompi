import type { KeyboardEvent } from 'react';

/** Digits are a shortcut, not the only way in: only the first nine can have one. */
export const MAX_DIGIT_SHORTCUT = 9;

/**
 * The keyboard an option list answers to, handled on whichever element the
 * surrounding overlay focuses. Every key it claims is consumed, so a digit
 * that answers the agent never also reaches the rail's session shortcuts.
 */
export function handleOptionListKey(
  event: KeyboardEvent,
  input: {
    options: readonly string[];
    cursor: number;
    onCursorChange: (cursor: number) => void;
    onSelect: (option: string) => void;
  },
): void {
  const { options, cursor, onCursorChange, onSelect } = input;
  const count = options.length;
  if (count === 0) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    onCursorChange((cursor + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    return;
  }
  if (event.key === 'Enter') {
    const option = options[cursor];
    if (option === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(option);
    return;
  }
  const index = Number.parseInt(event.key, 10) - 1;
  const option = Number.isInteger(index) && index < MAX_DIGIT_SHORTCUT ? options[index] : undefined;
  if (option === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  onSelect(option);
}

/** What the footer should promise, given how many options there are. */
export function optionListHint(count: number): string {
  return count > MAX_DIGIT_SHORTCUT ? 'up/down move · enter select · 1-9 jump' : '1-9 select · enter confirm';
}

/** The digit a row answers to, or the bullet that says it has none. */
export function optionMarker(index: number): string {
  return index < MAX_DIGIT_SHORTCUT ? String(index + 1) : '·';
}
