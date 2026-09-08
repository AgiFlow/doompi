import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** The tiny tracked-out caps that head every cockpit section (SESSIONS, ACTIVITY, MINOR MODES). */
export function SectionLabel({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="section-label"
      className={cn('font-mono text-2xs font-bold tracking-widest text-doom-faint uppercase', className)}
      {...props}
    />
  );
}
