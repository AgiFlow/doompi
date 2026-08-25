import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { CheckIcon, ChevronDownIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';

/**
 * A single choice from a list, on Radix rather than a native <select>: a
 * native one cannot be styled to the palette on every platform, and the
 * cockpit's model and mode pickers need the same surface a popover has.
 */
export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-7 cursor-pointer items-center justify-between gap-2 rounded border border-doom-border bg-doom-deep px-2.5 font-mono text-[11px] text-doom-hi outline-none transition-colors hover:border-doom-blue/50 focus-visible:ring-2 focus-visible:ring-doom-blue/50 disabled:pointer-events-none disabled:opacity-40 data-[placeholder]:text-doom-faint',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-doom-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  position = 'popper',
  sideOffset = 4,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded border border-doom-border bg-doom-panel font-mono shadow-xl outline-none data-[state=open]:animate-doom-rise',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1 text-[8px] font-bold tracking-[0.14em] text-doom-faint uppercase', className)}
      {...props}
    />
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-[3px] py-1.5 pr-2 pl-7 text-[11px] text-doom-hi outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-doom-deep',
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex h-3 w-3 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="h-3 w-3 text-doom-blue" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('my-1 h-px bg-doom-border-soft', className)}
      {...props}
    />
  );
}
