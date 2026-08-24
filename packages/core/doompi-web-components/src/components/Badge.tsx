import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

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
    },
    size: {
      xs: 'px-1.5 py-0.5 text-[8px] font-bold',
      sm: 'px-2 py-0.5 text-[10px]',
    },
  },
  defaultVariants: { tone: 'neutral', size: 'sm' },
});

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

/** An outlined chip in one of the accent tones; the Chip the cockpit mockup draws. */
export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
