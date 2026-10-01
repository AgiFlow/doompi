import { useState } from 'react';

import { trimSnippet } from '../lib/review';
import type { DiffSide } from '../types/diff';
import { Button } from './Button';
import { Textarea } from './Textarea';

/**
 * The box a selection raises: what was highlighted, and a note about it.
 *
 * The note is held here rather than in a store because it belongs to one open
 * box and dies with it; only a submitted comment is worth keeping, and the
 * owner decides where that goes.
 */
export interface ReviewCommentDraftProps {
  snippet: string;
  /** Absent when the selection came from somewhere lines cannot be recovered, such as a rendered preview. */
  startLine?: number;
  endLine?: number;
  /** Absent means the new side. */
  side?: DiffSide;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** Prefix for the test ids: `<prefix>-draft`, `-body`, `-add`, `-cancel`. */
  testIdPrefix?: string;
}

function rangeLabel(startLine: number | undefined, endLine: number | undefined, side: DiffSide | undefined): string {
  if (startLine === undefined) return 'no line anchor: this selection came from the rendered preview';
  const removed = side === 'old' ? 'removed ' : '';
  return endLine === undefined || endLine === startLine
    ? `${removed}line ${startLine}`
    : `${removed}lines ${startLine} to ${endLine}`;
}

export function ReviewCommentDraft({
  snippet,
  startLine,
  endLine,
  side,
  onSubmit,
  onCancel,
  testIdPrefix = 'review-comment',
}: ReviewCommentDraftProps) {
  const [body, setBody] = useState('');

  return (
    <div data-testid={`${testIdPrefix}-draft`} className="flex flex-col gap-1.5 border-t border-doom-border p-2">
      <p className="text-2xs text-doom-faint">{rangeLabel(startLine, endLine, side)}</p>
      <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded border border-doom-border-soft bg-doom-deep p-1.5 font-mono text-xs text-doom-dim">
        {trimSnippet(snippet, 8, 600)}
      </pre>
      <Textarea
        data-testid={`${testIdPrefix}-body`}
        value={body}
        rows={3}
        autoFocus
        placeholder="what should change here?"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          if (body.trim() !== '') onSubmit(body);
        }}
        className="text-sm"
      />
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          data-testid={`${testIdPrefix}-add`}
          disabled={body.trim() === ''}
          onClick={() => onSubmit(body)}
          className="text-2xs"
        >
          add comment
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-testid={`${testIdPrefix}-cancel`}
          onClick={onCancel}
          className="text-2xs"
        >
          cancel
        </Button>
        <span className="text-2xs text-doom-faint">⌘⏎ to add</span>
      </div>
    </div>
  );
}
