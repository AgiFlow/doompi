import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from '../icons/icons.ts';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';

/**
 * Puts a piece of text on the clipboard and says so.
 *
 * DESIGN PATTERNS:
 * - Always visible, dimmed. Half the cockpit's surfaces are touched rather
 *   than pointed at, and a control revealed by hover does not exist there.
 * - A refused clipboard is a state, not a crash: the label says the browser
 *   blocked it and the text is still there to select by hand.
 */

/** How long the control stays acknowledged before returning to its icon. */
const FEEDBACK_MS = 1500;

type CopyState = 'idle' | 'copied' | 'failed';

const LABELS: Readonly<Record<CopyState, string>> = {
  idle: 'copy',
  copied: 'copied',
  failed: 'copying was blocked by the browser',
};

export interface CopyButtonProps {
  /** What lands on the clipboard. */
  text: string;
  className?: string | undefined;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  }, [text]);

  const label = LABELS[state];
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="copy-button"
      data-state={state}
      title={label}
      aria-label={label}
      onClick={copy}
      className={cn('opacity-60 hover:opacity-100', className)}
    >
      {state === 'copied' ? <CheckIcon className="size-3 text-doom-green" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}
