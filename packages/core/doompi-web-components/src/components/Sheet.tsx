import { Dialog as SheetPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { CloseIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';

/**
 * A side panel on Radix's Dialog: an overlay that slides in from an edge,
 * with the focus trap, Escape, outside click and scroll lock a dialog has.
 *
 * It is the Dialog for content that reads as a column rather than a form: a
 * detail view beside what the reader was looking at. An inline aside cannot
 * do this, because it takes width from the surface underneath it.
 */
export function Sheet(props: ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetTrigger(props: ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export function SheetOverlay({ className, ...props }: ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn('fixed inset-0 z-40 bg-doom-deep/70 data-[state=open]:animate-doom-fade', className)}
      {...props}
    />
  );
}

const SIDE_POSITION = {
  right: 'inset-y-0 right-0 border-l data-[state=open]:animate-doom-slide-right',
  left: 'inset-y-0 left-0 border-r data-[state=open]:animate-doom-slide-left',
} as const;

export interface SheetContentProps extends ComponentProps<typeof SheetPrimitive.Content> {
  /** Which edge it comes from. */
  side?: 'right' | 'left';
  /** Width preset; `className` may still override. */
  width?: 'sm' | 'md' | 'lg';
}

const CONTENT_WIDTH = { sm: 'w-[360px]', md: 'w-[440px]', lg: 'w-[560px]' } as const;

export function SheetContent({ className, children, side = 'right', width = 'md', ...props }: SheetContentProps) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex max-w-[calc(100vw-24px)] flex-col overflow-hidden border-doom-border bg-doom-rail font-mono shadow-2xl outline-none',
          SIDE_POSITION[side],
          CONTENT_WIDTH[width],
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export interface SheetHeaderProps extends ComponentProps<'div'> {
  /** Show the close control at the right of the strip. On by default: a sheet is dismissed, not answered. */
  dismissible?: boolean;
  /** What the close control announces. */
  closeLabel?: string;
}

export function SheetHeader({
  className,
  dismissible = true,
  closeLabel = 'close',
  children,
  ...props
}: SheetHeaderProps) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex h-11 min-w-0 shrink-0 items-center gap-2.5 border-b border-doom-border px-4', className)}
      {...props}
    >
      {children}
      {dismissible ? (
        <SheetPrimitive.Close asChild>
          <Button variant="ghost" size="icon" aria-label={closeLabel} className="text-doom-faint hover:text-doom-hi">
            <CloseIcon className="h-3 w-3" />
          </Button>
        </SheetPrimitive.Close>
      ) : null}
    </div>
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('truncate text-[13px] font-bold text-doom-hi', className)}
      {...props}
    />
  );
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-[11px] leading-relaxed text-doom-dim', className)}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3', className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'flex min-h-[34px] shrink-0 flex-wrap items-center justify-between gap-2 border-t border-doom-border-soft bg-doom-deep px-4 py-1.5',
        className,
      )}
      {...props}
    />
  );
}
