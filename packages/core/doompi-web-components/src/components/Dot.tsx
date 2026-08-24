import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

export const dotVariants = cva('inline-block shrink-0 rounded-full', {
  variants: {
    tone: {
      neutral: 'bg-doom-faint',
      muted: 'bg-doom-faint/40',
      blue: 'bg-doom-blue',
      green: 'bg-doom-green',
      yellow: 'bg-doom-yellow',
      red: 'bg-doom-red',
      magenta: 'bg-doom-magenta',
      violet: 'bg-doom-violet',
      cyan: 'bg-doom-cyan',
    },
    size: {
      sm: 'h-1.5 w-1.5',
      md: 'h-2 w-2',
    },
    pulse: {
      true: 'animate-pulse',
      false: '',
    },
  },
  defaultVariants: { tone: 'neutral', size: 'sm', pulse: false },
});

export type DotTone = NonNullable<VariantProps<typeof dotVariants>['tone']>;

export interface DotProps extends ComponentProps<'span'>, VariantProps<typeof dotVariants> {}

/** The status dot: a colour and, while something is live, a pulse. */
export function Dot({ className, tone, size, pulse, ...props }: DotProps) {
  return <span data-slot="dot" aria-hidden className={cn(dotVariants({ tone, size, pulse }), className)} {...props} />;
}
