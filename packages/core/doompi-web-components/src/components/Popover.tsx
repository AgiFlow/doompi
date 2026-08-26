import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * shadcn's Popover on Radix: anchored to its trigger, closes on outside
 * click and Escape, and the trigger toggles it rather than reopening it.
 */
export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export function PopoverAnchor(props: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

/** Dismisses the popover from inside it: the row that acts and closes in one click. */
export function PopoverClose(props: ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 flex flex-col overflow-hidden rounded-lg border border-doom-border bg-doom-panel font-mono shadow-2xl outline-none data-[state=open]:animate-doom-rise',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/** The strip a popover's title sits in; tone colours the title. */
export function PopoverHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-header"
      className={cn(
        'flex h-[34px] shrink-0 items-center justify-between gap-3 border-b border-doom-border-soft bg-doom-deep px-3',
        className,
      )}
      {...props}
    />
  );
}

export function PopoverFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="popover-footer"
      className={cn(
        'flex min-h-[30px] shrink-0 items-center justify-between gap-3 border-t border-doom-border-soft bg-doom-deep px-3 text-[9px] text-doom-faint',
        className,
      )}
      {...props}
    />
  );
}
