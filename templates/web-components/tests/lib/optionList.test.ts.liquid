import type { KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { handleOptionListKey, MAX_DIGIT_SHORTCUT, optionListHint, optionMarker } from '../../src/exports/index.ts';

/** A keyboard event with only the parts the handler touches. */
function keyEvent(key: string): KeyboardEvent & { prevented: () => boolean; stopped: () => boolean } {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    key,
    preventDefault,
    stopPropagation,
    prevented: () => preventDefault.mock.calls.length > 0,
    stopped: () => stopPropagation.mock.calls.length > 0,
  } as unknown as KeyboardEvent & { prevented: () => boolean; stopped: () => boolean };
}

function harness(options: readonly string[], cursor = 0) {
  const onCursorChange = vi.fn();
  const onSelect = vi.fn();
  return {
    onCursorChange,
    onSelect,
    press(key: string) {
      const event = keyEvent(key);
      handleOptionListKey(event, { options, cursor, onCursorChange, onSelect });
      return event;
    },
  };
}

describe('handleOptionListKey', () => {
  it('wraps the cursor at both ends', () => {
    const down = harness(['a', 'b', 'c'], 2);
    down.press('ArrowDown');
    expect(down.onCursorChange).toHaveBeenCalledWith(0);

    const up = harness(['a', 'b', 'c'], 0);
    up.press('ArrowUp');
    expect(up.onCursorChange).toHaveBeenCalledWith(2);
  });

  it('selects the row under the cursor on Enter', () => {
    const list = harness(['a', 'b'], 1);
    list.press('Enter');
    expect(list.onSelect).toHaveBeenCalledWith('b');
  });

  it('jumps to a digit, and only for the first nine', () => {
    const options = Array.from({ length: 12 }, (_, index) => `option-${String(index)}`);
    const list = harness(options);
    list.press('3');
    expect(list.onSelect).toHaveBeenCalledWith('option-2');

    const zero = harness(options);
    // 0 would be index -1: not a row, so the key is left for whoever else wants it.
    const event = zero.press('0');
    expect(zero.onSelect).not.toHaveBeenCalled();
    expect(event.prevented()).toBe(false);
  });

  it('consumes every key it acts on, so a digit never also reaches the rail', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', '1']) {
      const event = harness(['a', 'b'], 0).press(key);
      expect(event.prevented(), key).toBe(true);
      expect(event.stopped(), key).toBe(true);
    }
  });

  it('leaves keys it does not claim alone, and does nothing without options', () => {
    const typing = harness(['a']);
    const event = typing.press('x');
    expect(event.prevented()).toBe(false);
    expect(typing.onSelect).not.toHaveBeenCalled();

    const empty = harness([]);
    empty.press('ArrowDown');
    empty.press('Enter');
    expect(empty.onCursorChange).not.toHaveBeenCalled();
    expect(empty.onSelect).not.toHaveBeenCalled();
  });

  it('ignores Enter on a cursor that points past the end', () => {
    const list = harness(['a'], 5);
    const event = list.press('Enter');
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(event.prevented()).toBe(false);
  });
});

describe('option list hints', () => {
  it('promises the digits only while every row has one', () => {
    expect(optionListHint(MAX_DIGIT_SHORTCUT)).toBe('1-9 select · enter confirm');
    expect(optionListHint(MAX_DIGIT_SHORTCUT + 1)).toContain('up/down move');
  });

  it('marks the first nine rows with their digit and the rest with a bullet', () => {
    expect(optionMarker(0)).toBe('1');
    expect(optionMarker(MAX_DIGIT_SHORTCUT - 1)).toBe(String(MAX_DIGIT_SHORTCUT));
    expect(optionMarker(MAX_DIGIT_SHORTCUT)).toBe('·');
  });
});
