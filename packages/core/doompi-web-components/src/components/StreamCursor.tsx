import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** The blinking block that marks text still arriving. */
export function StreamCursor({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="stream-cursor"
      aria-hidden
      className={cn('ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 animate-doom-blink bg-doom-blue', className)}
      {...props}
    />
  );
}
