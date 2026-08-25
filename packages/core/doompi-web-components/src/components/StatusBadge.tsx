import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export const statusBadgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[3px] font-mono font-bold uppercase',
  {
    variants: {
      tone: {
        neutral: 'bg-doom-panel text-doom-faint',
        running: 'bg-doom-tint-yellow text-doom-yellow',
        ok: 'bg-doom-tint-green text-doom-green',
        error: 'bg-doom-tint-red text-doom-red',
        info: 'bg-doom-tint-blue text-doom-blue',
        accent: 'bg-doom-tint-magenta text-doom-magenta',
      },
      size: {
        xs: 'px-1.5 py-0.5 text-[8px]',
        sm: 'px-[7px] py-[3px] text-[9px]',
        md: 'h-[21px] px-2 text-[10px] normal-case',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;

/**
 * The border a card wears for a status, the same tint family as the badge.
 * MessageItem builds its frame variants from this table, so a tone's edge is
 * named once and a card and its badge can never disagree about it.
 */
export const STATUS_EDGE: Readonly<Record<StatusTone, string>> = {
  neutral: 'border-doom-border',
  running: 'border-doom-edge-yellow',
  ok: 'border-doom-edge-green',
  error: 'border-doom-edge-red',
  info: 'border-doom-edge-blue',
  accent: 'border-doom-edge-magenta',
};

export interface StatusBadgeProps extends ComponentProps<'span'>, VariantProps<typeof statusBadgeVariants> {}

/** The tinted outcome pill: RUNNING, OK, ERROR and their kin, as every run card draws it. */
export function StatusBadge({ className, tone, size, ...props }: StatusBadgeProps) {
  return <span data-slot="status-badge" className={cn(statusBadgeVariants({ tone, size }), className)} {...props} />;
}
