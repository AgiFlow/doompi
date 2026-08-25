import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { optionMarker } from '../lib/optionList.ts';

export const optionListVariants = cva('flex min-h-0 flex-1 flex-col overflow-y-auto', {
  variants: {
    /** The compact rows of a bar popover, or the roomier rows of a modal. */
    density: { compact: 'gap-0.5 p-1.5', comfortable: 'gap-1.5' },
  },
  defaultVariants: { density: 'comfortable' },
});

export const optionRowVariants = cva('flex shrink-0 cursor-pointer items-center text-left outline-none', {
  variants: {
    density: {
      compact: 'gap-2.5 rounded-[5px] px-2 py-[7px]',
      comfortable: 'min-h-[42px] gap-3 rounded-md border px-[11px] py-2 text-[12px] text-doom-text transition-colors',
    },
    active: { true: '', false: '' },
  },
  compoundVariants: [
    { density: 'compact', active: true, class: 'bg-doom-tint-blue' },
    { density: 'comfortable', active: true, class: 'border-doom-edge-blue bg-doom-tint-blue' },
    { density: 'comfortable', active: false, class: 'border-doom-border-soft' },
  ],
  defaultVariants: { density: 'comfortable', active: false },
});

export const optionMarkerVariants = cva('flex shrink-0 items-center justify-center rounded-full font-bold', {
  variants: {
    density: {
      compact: 'h-[15px] w-[15px] border border-doom-border text-[8px] text-doom-faint',
      comfortable: 'h-[18px] w-[18px] bg-doom-deep text-[10px] text-doom-dim',
    },
  },
  defaultVariants: { density: 'comfortable' },
});

export interface OptionRowProps extends ComponentProps<'button'>, VariantProps<typeof optionRowVariants> {
  /** The digit or bullet in the row's leading circle; omit it for a row with no shortcut. */
  marker?: ReactNode;
}

/**
 * One row of an option list, exported on its own so a surface with richer
 * rows than a plain string still wears the list's shape instead of restating
 * it. Children render straight into the row, so a row is free to hold a name
 * and a description side by side; OptionLabel is the single-string case.
 * `role="option"` means a row belongs inside a `listbox`.
 */
export function OptionRow({ className, density, active, marker, children, ...props }: OptionRowProps) {
  return (
    <button
      type="button"
      role="option"
      data-slot="option-row"
      aria-selected={active ?? false}
      data-cursor={active ?? false}
      className={cn(optionRowVariants({ density, active }), className)}
      {...props}
    >
      {marker === undefined ? null : <span className={optionMarkerVariants({ density })}>{marker}</span>}
      {children}
    </button>
  );
}

/** A row's single-string label: it takes the remaining width and clips or wraps by density. */
export function OptionLabel({
  className,
  density,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof optionListVariants>) {
  return (
    <span
      data-slot="option-label"
      className={cn(
        'min-w-0 flex-1',
        density === 'compact' ? 'truncate text-[12px] text-doom-text' : 'break-words',
        className,
      )}
      {...props}
    />
  );
}

export interface OptionListProps
  extends Omit<ComponentProps<'div'>, 'onSelect'>, VariantProps<typeof optionListVariants> {
  options: readonly string[];
  /** The highlighted row, owned by the surface so its own focused element can drive it. */
  cursor: number;
  onCursorChange: (cursor: number) => void;
  onSelect: (option: string) => void;
  /** Rows are `${testIdPrefix}-${index}`; the list itself is the plural, so a prefix query for a row never catches it. */
  testIdPrefix: string;
}

/**
 * The answers a select surface offers, wherever it is framed.
 *
 * The agent decides how many options there are, and a real one runs past
 * twenty, so the list cannot rely on the digit shortcuts alone. The cursor is
 * controlled rather than owned here because the surface around it is what the
 * overlay library focuses: keys arrive there, and taking focus away from it to
 * a list would fight the library for it and break the escape and outside-click
 * behaviour that focus carries. Pair it with handleOptionListKey.
 */
export function OptionList({
  className,
  options,
  cursor,
  onCursorChange,
  onSelect,
  testIdPrefix,
  density = 'comfortable',
  ...props
}: OptionListProps) {
  const container = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible when the keyboard moves it past the edge.
  useEffect(() => {
    container.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div
      ref={container}
      role="listbox"
      aria-label="options"
      data-slot="option-list"
      data-testid={`${testIdPrefix}s`}
      className={cn(optionListVariants({ density }), className)}
      {...props}
    >
      {options.map((option, index) => (
        <OptionRow
          key={option}
          density={density}
          active={index === cursor}
          marker={optionMarker(index)}
          data-testid={`${testIdPrefix}-${String(index)}`}
          title={option}
          onMouseEnter={() => onCursorChange(index)}
          onClick={() => onSelect(option)}
        >
          <OptionLabel density={density}>{option}</OptionLabel>
        </OptionRow>
      ))}
    </div>
  );
}
