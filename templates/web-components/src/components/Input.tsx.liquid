import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * The shape both fields wear, so a single-line and a multi-line field in the
 * same form agree on their well, their type ramp, and their invalid state.
 * Textarea builds on it rather than restating it.
 */
export const fieldVariants = cva(
  'min-w-0 font-mono text-doom-hi outline-none placeholder:text-doom-faint disabled:opacity-50 aria-invalid:border-doom-edge-red aria-invalid:text-doom-red',
  {
    variants: {
      variant: {
        default: 'rounded border border-doom-border bg-doom-deep transition-colors focus:border-doom-blue/60',
        /** No well: a composer or a palette search that draws its own surface. */
        bare: 'border-0 bg-transparent',
      },
      /** The same rungs Button names, so a field and the button beside it line up. */
      size: {
        xs: 'px-1.5 py-0.5 text-[10px]',
        sm: 'px-2 py-1 text-[11px]',
        md: 'px-2.5 py-1.5 text-[12px]',
        lg: 'px-3 py-2 text-[13px]',
      },
    },
    compoundVariants: [
      // A bare field sits inside a surface that already has its own padding,
      // so it keeps the size's type ramp and gives up the size's box.
      { variant: 'bare', class: 'p-0' },
    ],
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type FieldVariant = NonNullable<VariantProps<typeof fieldVariants>['variant']>;
export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>['size']>;

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'>, VariantProps<typeof fieldVariants> {}

/** The one text field: deep well, quiet border, accent border on focus, red edge when invalid. */
export function Input({ className, type, variant, size, ...props }: InputProps) {
  return (
    <input
      type={type ?? 'text'}
      data-slot="input"
      spellCheck={false}
      className={cn(fieldVariants({ variant, size }), className)}
      {...props}
    />
  );
}
