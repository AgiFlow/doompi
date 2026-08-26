import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** An on/off track; use it where the change takes effect immediately, a checkbox where it needs a save. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-doom-border bg-doom-deep p-px outline-none transition-colors focus-visible:ring-2 focus-visible:ring-doom-blue/50 disabled:pointer-events-none disabled:opacity-40 data-[state=checked]:border-doom-blue data-[state=checked]:bg-doom-tint-blue',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block h-3 w-3 rounded-full bg-doom-faint transition-transform data-[state=checked]:translate-x-3 data-[state=checked]:bg-doom-blue"
      />
    </SwitchPrimitive.Root>
  );
}
