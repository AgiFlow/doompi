import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/**
 * The look a tab wears, whether Radix drives it or a router link does. It is
 * exported because the cockpit's own tabs navigate routes rather than swap
 * panels, and a link that looks like a tab must not be a second implementation.
 */
export const tabVariants = cva(
  'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[10px] transition-colors outline-none',
  {
    variants: {
      active: {
        true: 'bg-doom-tint-blue font-bold text-doom-blue',
        false: 'text-doom-dim hover:bg-doom-panel hover:text-doom-hi',
      },
    },
    defaultVariants: { active: false },
  },
);

/** The count a tab carries; it inverts on the active tab so it stays readable on the tint. */
export const tabBadgeVariants = cva(
  'flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[8px] font-bold',
  {
    variants: {
      active: { true: 'bg-doom-blue text-doom-rail', false: 'bg-doom-panel text-doom-dim' },
    },
    defaultVariants: { active: false },
  },
);

export interface NavTabProps extends ComponentProps<'a'>, VariantProps<typeof tabVariants> {
  /** Render the child element instead of an <a>, so a router Link can be the tab. */
  asChild?: boolean;
}

/**
 * A tab that navigates. Radix Tabs owns panels and roving focus over content
 * it renders; a route-driven tab strip has neither, so it gets the styling and
 * leaves the semantics to the router.
 */
export function NavTab({ className, active, asChild = false, ...props }: NavTabProps) {
  const Component = asChild ? Slot.Root : 'a';
  return (
    <Component
      data-slot="nav-tab"
      data-active={active ?? false}
      className={cn(tabVariants({ active }), className)}
      {...props}
    />
  );
}

/** The count beside a tab's label. */
export function NavTabBadge({
  className,
  active,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof tabBadgeVariants>) {
  return <span data-slot="nav-tab-badge" className={cn(tabBadgeVariants({ active }), className)} {...props} />;
}

/** Radix Tabs, for a surface that swaps panels in place rather than navigating. */
export function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn('flex items-center gap-1', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        tabVariants({ active: false }),
        'data-[state=active]:bg-doom-tint-blue data-[state=active]:font-bold data-[state=active]:text-doom-blue',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('min-h-0 flex-1', className)} {...props} />;
}
