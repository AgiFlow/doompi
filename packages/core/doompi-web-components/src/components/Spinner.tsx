import type { ComponentProps } from 'react';
import { LoaderIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';

export interface SpinnerProps extends ComponentProps<'svg'> {
  /**
   * What the wait is for. Given one, the spinner announces itself as a live
   * status instead of staying silent, which is the difference between a
   * screen reader saying "loading providers" and saying nothing at all.
   */
  label?: string;
}

/** A turning loader in the current text colour; decorative unless it is given a label. */
export function Spinner({ className, label, ...props }: SpinnerProps) {
  const icon = (
    <LoaderIcon data-slot="spinner" aria-hidden className={cn('h-3 w-3 animate-spin', className)} {...props} />
  );
  if (label === undefined) return icon;
  return (
    <span data-slot="spinner-status" role="status" className="inline-flex items-center">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
