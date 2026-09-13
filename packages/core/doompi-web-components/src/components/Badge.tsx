import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn';
import type { ChipTone } from '../types/tone';

export const badgeVariants = cva('inline-flex items-center gap-1.5 whitespace-nowrap rounded border font-mono', {
  variants: {
    tone: {
      neutral: 'border-doom-border text-doom-dim',
      blue: 'border-doom-blue/40 text-doom-blue',
      green: 'border-doom-green/40 text-doom-green',
      yellow: 'border-doom-yellow/40 text-doom-yellow',
      red: 'border-doom-red/40 text-doom-red',
      magenta: 'border-doom-magenta/40 text-doom-magenta',
      violet: 'border-doom-violet/40 text-doom-violet',
      cyan: 'border-doom-cyan/40 text-doom-cyan',
      orange: 'border-doom-orange/40 text-doom-orange',
      teal: 'border-doom-teal/40 text-doom-teal',
    } satisfies Record<ChipTone, string>,
    /** The same rungs Button names, so a chip can sit beside a button of any size. */
    size: {
      xs: 'px-1.5 py-0.5 text-2xs font-bold',
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-1 text-sm',
      lg: 'px-3 py-1.5 text-base',
    },
  },
  defaultVariants: { tone: 'neutral', size: 'sm' },
});

export type BadgeTone = ChipTone;

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  /** Render the child element instead of a <span>, so a link can look like a chip. */
  asChild?: boolean;
}

/** An outlined chip in one of the accent tones; the Chip the cockpit mockup draws. */
export function Badge({ className, tone, size, asChild = false, ...props }: BadgeProps) {
  const Component = asChild ? Slot.Root : 'span';
  return <Component data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
