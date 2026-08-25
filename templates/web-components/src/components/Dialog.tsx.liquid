import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { CloseIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';

/**
 * shadcn's Dialog on Radix: focus trap, Escape, outside click, scroll lock,
 * and focus restored to the trigger on close. The frame is the Doom panel.
 */
export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn('fixed inset-0 z-40 bg-doom-deep/70 data-[state=open]:animate-doom-fade', className)}
      {...props}
    />
  );
}

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Width preset; `className` may still override. */
  width?: 'sm' | 'md' | 'lg';
}

const CONTENT_WIDTH = { sm: 'w-[360px]', md: 'w-[480px]', lg: 'w-[620px]' } as const;

export function DialogContent({ className, children, width = 'md', ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-doom-border bg-doom-panel font-mono shadow-2xl outline-none data-[state=open]:animate-doom-pop',
          CONTENT_WIDTH[width],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export interface DialogHeaderProps extends ComponentProps<'div'> {
  /**
   * Show the close control at the right of the strip. Off by default: most
   * headers already put something there (a spinner, a method label) and every
   * dialog closes on Escape, so an X that fights the existing content is worse
   * than none. Turn it on for a dialog whose only way out is the mouse.
   */
  dismissible?: boolean;
  /** What the close control announces. */
  closeLabel?: string;
}

export function DialogHeader({
  className,
  dismissible = false,
  closeLabel = 'close',
  children,
  ...props
}: DialogHeaderProps) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex items-center justify-between gap-3 border-b border-doom-border px-4 py-3', className)}
      {...props}
    >
      {children}
      {dismissible ? (
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon" aria-label={closeLabel} className="text-doom-faint hover:text-doom-hi">
            <CloseIcon className="h-3 w-3" />
          </Button>
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-[12px] font-bold tracking-wide text-doom-hi', className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[11px] leading-relaxed text-doom-dim', className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4', className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex items-center justify-end gap-2', className)} {...props} />;
}
