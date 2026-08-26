import { cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.ts';
import type { MessageLineTone as Tone } from '../types/tone.ts';

/** One line of a message body, with the tone the card's pure view logic chose for it. */
export type MessageLineTone = Tone;

export interface MessageLine {
  text: string;
  tone: MessageLineTone;
  bold?: boolean;
  indent?: boolean;
}

export const messageLineVariants = cva('whitespace-pre-wrap break-words', {
  variants: {
    tone: {
      hi: 'text-doom-hi',
      text: 'text-doom-text',
      dim: 'text-doom-dim',
      muted: 'text-doom-faint',
      success: 'text-doom-green',
      error: 'text-doom-red',
      warning: 'text-doom-yellow',
      accent: 'text-doom-blue',
    } satisfies Record<Tone, string>,
    bold: { true: 'font-bold', false: '' },
    indent: { true: 'pl-4', false: '' },
  },
  defaultVariants: { tone: 'dim', bold: false, indent: false },
});

export interface MessageLinesProps extends ComponentProps<'div'> {
  lines: readonly MessageLine[];
}

/** A body of toned lines: what a card's view helper computed, drawn one line per row. */
export function MessageLines({ className, lines, ...props }: MessageLinesProps) {
  return (
    <div data-slot="message-lines" className={cn('flex flex-col gap-0.5', className)} {...props}>
      {lines.map((line, index) => (
        <div
          key={`${String(index)}-${line.text}`}
          className={messageLineVariants({ tone: line.tone, bold: line.bold === true, indent: line.indent === true })}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}
