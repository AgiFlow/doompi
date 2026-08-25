import { cva, type VariantProps } from 'class-variance-authority';
import { Toast as ToastPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { CloseIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import type { StatusTone } from '../types/tone.ts';

/**
 * A transient notice. Radix owns the part that is easy to get wrong: it
 * announces through a live region, pauses its timer on hover and on window
 * blur, and restores focus when it leaves. Mount one ToastProvider and one
 * ToastViewport per page.
 */
export function ToastProvider(props: ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider {...props} />;
}

export function ToastViewport({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn('fixed right-4 bottom-4 z-50 flex w-[360px] max-w-full flex-col gap-2 outline-none', className)}
      {...props}
    />
  );
}

export const toastVariants = cva(
  'flex items-start gap-3 rounded-md border bg-doom-panel px-3 py-2.5 font-mono shadow-2xl data-[state=open]:animate-doom-rise',
  {
    variants: {
      tone: {
        neutral: 'border-doom-border',
        running: 'border-doom-edge-yellow',
        ok: 'border-doom-edge-green',
        error: 'border-doom-edge-red',
        info: 'border-doom-edge-blue',
        accent: 'border-doom-edge-magenta',
      } satisfies Record<StatusTone, string>,
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface ToastProps extends ComponentProps<typeof ToastPrimitive.Root>, VariantProps<typeof toastVariants> {}

export function Toast({ className, tone, ...props }: ToastProps) {
  return <ToastPrimitive.Root data-slot="toast" className={cn(toastVariants({ tone }), className)} {...props} />;
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn('text-[11px] font-bold text-doom-hi', className)}
      {...props}
    />
  );
}

export function ToastDescription({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn('text-[11px] leading-relaxed text-doom-dim', className)}
      {...props}
    />
  );
}

export function ToastAction(props: ComponentProps<typeof ToastPrimitive.Action>) {
  return <ToastPrimitive.Action data-slot="toast-action" {...props} />;
}

export function ToastClose({ className, ...props }: ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="dismiss"
      className={cn('shrink-0 cursor-pointer text-doom-faint transition-colors hover:text-doom-hi', className)}
      {...props}
    >
      <CloseIcon className="h-3 w-3" />
    </ToastPrimitive.Close>
  );
}
