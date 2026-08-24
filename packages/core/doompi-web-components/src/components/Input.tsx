import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** The one text field: deep well, quiet border, accent ring on focus. */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type ?? 'text'}
      data-slot="input"
      spellCheck={false}
      className={cn(
        'min-w-0 rounded border border-doom-border bg-doom-deep px-2.5 py-1.5 font-mono text-[12px] text-doom-hi outline-none transition-colors placeholder:text-doom-faint focus:border-doom-blue/60 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
