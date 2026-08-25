import { useEffect, useRef } from 'react';

/** Digits are a shortcut, not the only way in: only the first nine can have one. */
const MAX_DIGIT_SHORTCUT = 9;

export interface OptionListProps {
  options: readonly string[];
  /** The highlighted row, owned by the surface so its own focused element can drive it. */
  cursor: number;
  onCursorChange: (cursor: number) => void;
  onSelect: (option: string) => void;
  /** Rows are `${testIdPrefix}-${index}`; the list itself is the plural, so a prefix query for a row never catches it. */
  testIdPrefix: string;
  /** The compact rows of a bar popover, or the roomier rows of a modal. */
  density?: 'compact' | 'comfortable';
}

/**
 * The answers a select dialog offers, wherever it is framed.
 *
 * The agent decides how many options there are, and a real one runs past
 * twenty, so the list cannot rely on the digit shortcuts alone. The cursor is
 * controlled rather than owned here because the surface around it is what the
 * overlay library focuses: keys arrive there, and taking focus away from it to
 * a list would fight the library for it and break the escape and outside-click
 * behaviour that focus carries.
 */
export function OptionList({
  options,
  cursor,
  onCursorChange,
  onSelect,
  testIdPrefix,
  density = 'comfortable',
}: OptionListProps) {
  const container = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible when the keyboard moves it past the edge.
  useEffect(() => {
    container.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const compact = density === 'compact';
  return (
    <div
      ref={container}
      role="listbox"
      aria-label="options"
      data-testid={`${testIdPrefix}s`}
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${compact ? 'gap-0.5 p-1.5' : 'gap-1.5'}`}
    >
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          role="option"
          aria-selected={index === cursor}
          data-testid={`${testIdPrefix}-${String(index)}`}
          data-cursor={index === cursor}
          title={option}
          onMouseEnter={() => onCursorChange(index)}
          onClick={() => onSelect(option)}
          className={
            compact
              ? `flex shrink-0 items-center gap-2.5 rounded-[5px] px-2 py-[7px] text-left outline-none ${
                  index === cursor ? 'bg-doom-tint-blue' : ''
                }`
              : `flex min-h-[42px] shrink-0 items-center gap-3 rounded-md border px-[11px] py-2 text-left text-[12px] text-doom-text transition-colors outline-none ${
                  index === cursor ? 'border-doom-edge-blue bg-doom-tint-blue' : 'border-doom-border-soft'
                }`
          }
        >
          <span
            className={
              compact
                ? 'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-doom-border text-[8px] font-bold text-doom-faint'
                : 'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-doom-deep text-[10px] font-bold text-doom-dim'
            }
          >
            {index < MAX_DIGIT_SHORTCUT ? index + 1 : '·'}
          </span>
          <span className={`min-w-0 flex-1 ${compact ? 'truncate text-[12px] text-doom-text' : 'break-words'}`}>
            {option}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The keyboard an option list answers to, handled on whichever element the
 * surrounding overlay focuses. Every key it claims is consumed, so a digit
 * that answers the agent never also reaches the rail's session shortcuts.
 */
export function handleOptionListKey(
  event: React.KeyboardEvent,
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
