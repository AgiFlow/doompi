import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** The multi-line field, styled as the Input; `bare` drops the well for a composer that draws its own. */
export function Textarea({ className, bare = false, ...props }: ComponentProps<'textarea'> & { bare?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-w-0 resize-none font-mono text-[12px] text-doom-hi outline-none placeholder:text-doom-faint disabled:opacity-50',
        bare
          ? 'bg-transparent'
          : 'rounded border border-doom-border bg-doom-deep px-3 py-2 transition-colors focus:border-doom-blue/60',
        className,
      )}
      {...props}
    />
  );
}
