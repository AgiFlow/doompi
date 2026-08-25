import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * The shape of content that has not arrived. It has no Radix counterpart; it
 * is a pulsing block, and it is aria-hidden because the live region that
 * announces the wait belongs to the surface, not to each placeholder.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('animate-pulse rounded bg-doom-border-soft', className)}
      {...props}
    />
  );
}
