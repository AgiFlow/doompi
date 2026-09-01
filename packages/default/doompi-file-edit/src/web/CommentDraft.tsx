import { Button, Textarea } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import { trimSnippet } from './fileView.ts';

/**
 * The box a selection raises: what was highlighted, and a note about it.
 *
 * The note is held here rather than in the session store because it belongs to
 * one open box and dies with it; only a submitted comment is worth surviving a
 * re-render, and that goes to the store.
 */
export interface CommentDraftProps {
  snippet: string;
  /** Absent when the selection came from a rendered preview, where lines cannot be recovered. */
  startLine?: number;
  endLine?: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

export function CommentDraft({ snippet, startLine, endLine, onSubmit, onCancel }: CommentDraftProps) {
  const [body, setBody] = useState('');
  const range =
    startLine === undefined
      ? 'no line anchor: this selection came from the rendered preview'
      : endLine === undefined || endLine === startLine
        ? `line ${startLine}`
        : `lines ${startLine} to ${endLine}`;

  return (
    <div data-testid="files-comment-draft" className="flex flex-col gap-1.5 border-t border-doom-border p-2">
      <p className="text-[9px] text-doom-faint">{range}</p>
      <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded border border-doom-border-soft bg-doom-deep p-1.5 font-mono text-[10px] text-doom-dim">
        {trimSnippet(snippet, 8, 600)}
      </pre>
      <Textarea
        data-testid="files-comment-body"
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
        className="text-[11px]"
      />
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          data-testid="files-comment-add"
          disabled={body.trim() === ''}
          onClick={() => onSubmit(body)}
          className="text-[9px]"
        >
          add comment
        </Button>
        <Button variant="ghost" size="xs" data-testid="files-comment-cancel" onClick={onCancel} className="text-[9px]">
          cancel
        </Button>
        <span className="text-[9px] text-doom-faint">⌘⏎ to add</span>
      </div>
    </div>
  );
}
