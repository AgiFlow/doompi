import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** A field's name: clicking it focuses the control, which a bare span never does. */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-1.5 text-[10px] text-doom-faint select-none has-[+:disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
