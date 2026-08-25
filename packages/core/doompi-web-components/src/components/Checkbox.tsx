import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { CheckIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';

/** A box that is on, off, or indeterminate; the tick is the accent on the deep well. */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border border-doom-border bg-doom-deep outline-none transition-colors focus-visible:ring-2 focus-visible:ring-doom-blue/50 disabled:pointer-events-none disabled:opacity-40 data-[state=checked]:border-doom-blue data-[state=indeterminate]:border-doom-blue',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="text-doom-blue">
        <CheckIcon className="h-2.5 w-2.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
