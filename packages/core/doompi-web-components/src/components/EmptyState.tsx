import { Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Optional calls to action under the copy. */
  children?: ReactNode;
  /**
   * Render the child element instead of a <div>, so an empty row inside a
   * list stays an <li> and the list keeps its semantics.
   */
  asChild?: boolean;
}

/** The centred "nothing here yet" card every empty panel shares. */
export function EmptyState({ title, description, children, className, asChild = false, ...props }: EmptyStateProps) {
  const Component = asChild ? Slot.Root : 'div';
  return (
    <Component
      data-slot="empty-state"
      className={cn('flex flex-1 items-center justify-center px-3 py-4 sm:px-4', className)}
      {...props}
    >
      <div className="flex w-[520px] max-w-full flex-col items-center gap-3 text-center">
        <span className="text-[14px] font-bold text-doom-hi">{title}</span>
        {description ? <span className="text-[11px] leading-relaxed text-doom-dim">{description}</span> : null}
        {children}
      </div>
    </Component>
  );
}
