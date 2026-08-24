import { cva, type VariantProps } from 'class-variance-authority';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';

/** shadcn's DropdownMenu on Radix: roving focus, typeahead, outside click, Escape. */
export function DropdownMenu(props: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger(props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export function DropdownMenuContent({
  className,
  align = 'end',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 flex min-w-[120px] flex-col overflow-hidden rounded border border-doom-border bg-doom-panel py-1 font-mono shadow-xl outline-none data-[state=open]:animate-doom-rise',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const itemVariants = cva(
  'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-doom-deep',
  {
    variants: {
      variant: {
        default: 'text-doom-hi',
        destructive: 'text-doom-red',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface DropdownMenuItemProps
  extends ComponentProps<typeof DropdownMenuPrimitive.Item>, VariantProps<typeof itemVariants> {}

export function DropdownMenuItem({ className, variant, ...props }: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant ?? 'default'}
      className={cn(itemVariants({ variant }), className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn('px-2.5 py-1 text-[8px] font-bold tracking-[0.14em] text-doom-faint uppercase', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-1 h-px bg-doom-border-soft', className)}
      {...props}
    />
  );
}
