import { Accordion as AccordionPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { ChevronDownIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';

/** Several collapsibles that know about each other; pass type="single" for one open at a time. */
export function Accordion(props: ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

export function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b border-doom-border-soft last:border-b-0', className)}
      {...props}
    />
  );
}

export function AccordionTrigger({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'flex flex-1 cursor-pointer items-center justify-between gap-2 py-2 text-left text-[11px] text-doom-hi outline-none transition-colors hover:text-doom-blue focus-visible:text-doom-blue [&[data-state=open]>svg]:rotate-180',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-doom-faint transition-transform" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className={cn('overflow-hidden pb-2 text-[11px] text-doom-dim', className)}
      {...props}
    />
  );
}
