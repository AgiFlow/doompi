import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { Dialog, DialogContent, type DialogContentProps, DialogTitle } from './Dialog.tsx';
import { Input, type InputProps } from './Input.tsx';
import { OptionRow, type OptionRowProps } from './OptionList.tsx';

/**
 * The command palette's frame, its search strip, its rows, and its hint.
 *
 * It has no Radix counterpart and it deliberately does no filtering: the
 * surface that opens a palette already knows how to rank its own commands,
 * and a matcher baked in here would be a second, worse one. Built on Dialog,
 * Input, and the option row so a palette and a select popover cannot drift
 * apart, rather than on a new dependency.
 */

export interface CommandDialogProps extends Omit<DialogContentProps, 'title'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the dialog for assistive tech; visually hidden unless the palette draws its own heading. */
  title: ReactNode;
  titleVisible?: boolean;
}

export function CommandDialog({
  open,
  onOpenChange,
  title,
  titleVisible = false,
  className,
  children,
  width = 'lg',
  ...props
}: CommandDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="command-dialog" width={width} className={cn('max-h-[70vh]', className)} {...props}>
        <DialogTitle className={titleVisible ? undefined : 'sr-only'}>{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The strip the search field sits in. */
export function CommandHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-header"
      className={cn('flex shrink-0 items-center gap-2 border-b border-doom-border px-3 py-2.5', className)}
      {...props}
    />
  );
}

/** The search field: bare, because the header already draws the surface. */
export function CommandInput({ className, ...props }: InputProps) {
  return (
    <Input
      data-slot="command-input"
      variant="bare"
      autoFocus
      autoComplete="off"
      className={cn('flex-1', className)}
      {...props}
    />
  );
}

/** The scrolling body. It is the listbox, so its rows are the options. */
export function CommandList({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="listbox"
      data-slot="command-list"
      className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5', className)}
      {...props}
    />
  );
}

/** A labelled run of rows. */
export function CommandGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="command-group" className={cn('flex flex-col gap-0.5', className)} {...props} />;
}

export function CommandGroupLabel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-group-label"
      className={cn('px-2 pt-2 pb-1 text-[8px] font-bold tracking-[0.14em] text-doom-faint uppercase', className)}
      {...props}
    />
  );
}

/** One command. Compact by default, since a palette shows many at once. */
export function CommandItem({ density = 'compact', ...props }: OptionRowProps) {
  return <OptionRow data-slot="command-item" density={density} {...props} />;
}

/** What the palette says when nothing matches. */
export function CommandEmpty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-empty"
      className={cn('px-2 py-6 text-center text-[11px] text-doom-faint', className)}
      {...props}
    />
  );
}

/** The hint strip along the bottom: what the keys do. */
export function CommandFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        'flex min-h-[30px] shrink-0 items-center justify-between gap-3 border-t border-doom-border-soft bg-doom-deep px-3 text-[9px] text-doom-faint',
        className,
      )}
      {...props}
    />
  );
}
