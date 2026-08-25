import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';
import { Spinner } from './Spinner.tsx';

export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-mono transition-[color,background-color,border-color,filter] outline-none focus-visible:ring-2 focus-visible:ring-doom-blue/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-doom-blue font-bold text-doom-rail hover:brightness-110',
        outline: 'border border-doom-border text-doom-dim hover:border-doom-blue/50 hover:text-doom-hi',
        ghost: 'text-doom-dim hover:bg-doom-panel hover:text-doom-hi',
        subtle: 'bg-doom-panel text-doom-dim hover:bg-doom-deep hover:text-doom-hi',
        danger: 'bg-doom-red font-bold text-doom-rail hover:brightness-110',
        'danger-outline': 'border border-doom-edge-red bg-doom-tint-red font-bold text-doom-red hover:brightness-110',
        success: 'bg-doom-green font-bold text-doom-rail hover:brightness-110',
        link: 'text-doom-blue hover:underline',
      },
      size: {
        xs: 'h-5 rounded px-1.5 text-[9px]',
        sm: 'h-6 px-2.5 text-[10px]',
        md: 'h-7 px-3 text-[11px]',
        lg: 'h-8 px-3.5 text-[12px]',
        icon: 'h-5 w-5 rounded p-0',
        'icon-md': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a <button>, passing the classes down (shadcn's asChild). */
  asChild?: boolean;
  /**
   * Work is in flight: the button shows a spinner and stops accepting clicks.
   * Ignored under asChild, where the child owns its own content.
   */
  loading?: boolean;
  /** What the spinner announces while loading; omit it and the wait is silent. */
  loadingLabel?: string;
}

/** The one button: every variant is a theme token, so it recolours with the theme. */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  loadingLabel,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  const busy = !asChild && loading;
  return (
    <Component
      data-slot="button"
      type={asChild ? undefined : (type ?? 'button')}
      aria-busy={busy ? true : undefined}
      disabled={asChild ? undefined : (disabled ?? busy)}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {/* Slot takes exactly one child, so asChild hands its element straight through. */}
      {asChild ? (
        children
      ) : (
        <>
          {busy ? <Spinner label={loadingLabel} /> : null}
          {children}
        </>
      )}
    </Component>
  );
}
