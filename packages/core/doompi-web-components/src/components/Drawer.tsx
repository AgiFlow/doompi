import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ReactNode, useRef } from 'react';

import { cn } from '../lib/cn';
import { Dialog, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from './Dialog';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: 'left' | 'right';
  title: string;
  children: ReactNode;
  className?: string;
  showHeader?: boolean;
  'data-testid'?: string;
  backdropTestId?: string;
}

/** A controlled side panel with a focus trap and restoration for external header buttons. */
export function Drawer({
  open,
  onOpenChange,
  side,
  title,
  children,
  className,
  showHeader = true,
  'data-testid': testId,
  backdropTestId,
}: DrawerProps) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay data-testid={backdropTestId} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid={testId}
          className={cn(
            'fixed inset-y-0 z-50 flex w-[min(300px,calc(100vw-48px))] flex-col overflow-y-auto border-doom-border bg-doom-rail outline-none',
            side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
            className,
          )}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
        >
          {showHeader ? (
            <DialogHeader dismissible closeLabel={`hide ${title.toLowerCase()}`}>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
          ) : (
            <DialogTitle className="sr-only">{title}</DialogTitle>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
