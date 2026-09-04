import { CodeEditor, Markdown } from '@agimon-ai/doompi-web-components';
import { useRef } from 'react';
import {
  authorDocument,
  reviseAuthorDocument,
  setAuthorRegionCandidate,
  type AuthorWorkspaceDocument,
} from './authorWorkspaceStore.ts';

export function AuthorTextView({
  sessionId,
  document,
  preview,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  preview: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host} className="flex min-h-0 flex-1 flex-col">
      {preview ? (
        <div data-testid="author-markdown" className="min-h-0 flex-1 overflow-auto p-4 text-[12px] text-doom-text">
          <Markdown text={document.content ?? ''} />
        </div>
      ) : (
        <CodeEditor
          value={document.content ?? ''}
          path={document.path}
          data-testid="author-editor"
          className="min-h-0 flex-1"
          onChange={(content) => reviseAuthorDocument(sessionId, document.path, content)}
          onSelect={(range) => {
            const current = authorDocument(sessionId, document.path);
            const bounds = host.current?.getBoundingClientRect();
            if (!current || !bounds || range.from === range.to) return;
            setAuthorRegionCandidate(sessionId, {
              documentPath: current.path,
              revision: current.version,
              sourceSha256: current.sourceSha256,
              quote: range.text,
              anchor: {
                kind: 'text-range',
                startOffset: range.from,
                endOffset: range.to,
                startLine: range.startLine,
                endLine: range.endLine,
              },
              viewport: { width: bounds.width, height: bounds.height },
              createdAt: Date.now(),
            });
          }}
        />
      )}
    </div>
  );
}
