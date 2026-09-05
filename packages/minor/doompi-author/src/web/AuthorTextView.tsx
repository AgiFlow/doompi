import { CodeEditor, Markdown, type CodeEditorController } from '@agimon-ai/doompi-web-components';
import { useEffect, useRef } from 'react';
import type { AuthorDisplayedRegion } from './authorViewportTypes.ts';
import { registerAuthorGridResolver } from './authorGrid.ts';
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
  displayedRegions,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  preview: boolean;
  displayedRegions: readonly AuthorDisplayedRegion[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditorController>(null);
  useEffect(
    () =>
      registerAuthorGridResolver(sessionId, (cell, geometry) => {
        if (preview || editor.current === null) return undefined;
        const { originX = 0, originY = 0, width, height } = geometry.viewport;
        const range = editor.current.resolveViewportRegion({
          left: originX + cell.rect.x * width,
          top: originY + cell.rect.y * height,
          right: originX + (cell.rect.x + cell.rect.width) * width,
          bottom: originY + (cell.rect.y + cell.rect.height) * height,
        });
        if (range === null || range.from === range.to) return undefined;
        return {
          anchor: {
            kind: 'text-range',
            startOffset: range.from,
            endOffset: range.to,
            startLine: range.startLine,
            endLine: range.endLine,
          },
          quote: range.text,
        };
      }),
    [preview, sessionId],
  );
  useEffect(() => {
    editor.current?.setMarkedRanges(
      displayedRegions.flatMap(({ ordinal, region }) =>
        region.anchor.kind === 'text-range'
          ? [{ from: region.anchor.startOffset, to: region.anchor.endOffset, label: String(ordinal) }]
          : [],
      ),
    );
  }, [displayedRegions]);
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
          controllerRef={editor}
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
