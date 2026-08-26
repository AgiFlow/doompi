import { cva, type VariantProps } from 'class-variance-authority';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';

/** shadcn's DropdownMenu on Radix: roving focus, typeahead, outside click, Escape. */
export function DropdownMenu(props: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger(props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/** A run of items under one label, so the separator between groups is structural. */
export function DropdownMenuGroup(props: ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/** The surface every menu and submenu wears. */
const CONTENT_CLASS =
  'z-50 flex min-w-[120px] flex-col overflow-hidden rounded border border-doom-border bg-doom-panel py-1 font-mono shadow-xl outline-none data-[state=open]:animate-doom-rise';

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
        className={cn(CONTENT_CLASS, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export const dropdownMenuItemVariants = cva(
  'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-doom-deep',
  {
    variants: {
      variant: {
        default: 'text-doom-hi',
        destructive: 'text-doom-red',
      },
      /** A row that carries a check or bullet keeps a gutter for it, so labels line up whether or not one is set. */
      indented: { true: 'pl-7', false: '' },
    },
    defaultVariants: { variant: 'default', indented: false },
  },
);

export interface DropdownMenuItemProps
  extends ComponentProps<typeof DropdownMenuPrimitive.Item>, VariantProps<typeof dropdownMenuItemVariants> {}

export function DropdownMenuItem({ className, variant, indented, ...props }: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant ?? 'default'}
      className={cn(dropdownMenuItemVariants({ variant, indented }), className)}
      {...props}
    />
  );
}

/** The check or bullet a selectable row shows when it is set; it sits in the row's gutter. */
function ItemIndicator({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-2.5 flex h-3 w-3 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>{children}</DropdownMenuPrimitive.ItemIndicator>
    </span>
  );
}

export interface DropdownMenuCheckboxItemProps
  extends ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>, VariantProps<typeof dropdownMenuItemVariants> {}

/** A row that toggles: the check lives in the gutter so the label never shifts. */
export function DropdownMenuCheckboxItem({ className, variant, children, ...props }: DropdownMenuCheckboxItemProps) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn('relative', dropdownMenuItemVariants({ variant, indented: true }), className)}
      {...props}
    >
      <ItemIndicator>
        <CheckIcon className="h-3 w-3 text-doom-blue" />
      </ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/** The exclusive-choice group; pair it with DropdownMenuRadioItem. */
export function DropdownMenuRadioGroup(props: ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

export interface DropdownMenuRadioItemProps
  extends ComponentProps<typeof DropdownMenuPrimitive.RadioItem>, VariantProps<typeof dropdownMenuItemVariants> {}

export function DropdownMenuRadioItem({ className, variant, children, ...props }: DropdownMenuRadioItemProps) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn('relative', dropdownMenuItemVariants({ variant, indented: true }), className)}
      {...props}
    >
      <ItemIndicator>
        <span className="h-1.5 w-1.5 rounded-full bg-doom-blue" />
      </ItemIndicator>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSub(props: ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

/** The row that opens a submenu; the chevron is part of the row, not the caller's job. */
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(dropdownMenuItemVariants(), 'data-[state=open]:bg-doom-deep', className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRightIcon className="h-3 w-3 shrink-0 text-doom-faint" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  sideOffset = 2,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        sideOffset={sideOffset}
        className={cn(CONTENT_CLASS, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
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

/** The keystroke printed at the right of a row; the row supplies the gap. */
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto shrink-0 text-[10px] tracking-[0.08em] text-doom-faint', className)}
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
