import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import type { AuthorDocumentKind, AuthorToolMode } from '../lib/authorViewportTypes';
import {
  authorDocument,
  authorSessionWorkspace,
  reviseAuthorDocument,
  setAuthorRegionCandidate,
  setAuthorToolMode,
} from '../stores/authorWorkspaceStore';

export function AuthorToolPalette({
  sessionId,
  kind,
  activeTool,
}: {
  sessionId: string;
  kind: AuthorDocumentKind;
  activeTool: AuthorToolMode;
}) {
  const [error, setError] = useState<string>();
  const format = (style: 'Bold' | 'Heading' | 'Link' | 'List') => {
    const session = authorSessionWorkspace(sessionId);
    const selected = session.candidate;
    const document = selected && authorDocument(sessionId, selected.documentPath);
    if (
      !selected ||
      !document ||
      selected.anchor.kind !== 'text-range' ||
      selected.revision !== document.version ||
      selected.sourceSha256 !== document.sourceSha256
    ) {
      setError('Select text in the document first.');
      return;
    }
    const { startOffset, endOffset } = selected.anchor;
    const content = document.content ?? '';
    const text = content.slice(startOffset, endOffset);
    const replacement =
      style === 'Bold'
        ? `**${text}**`
        : style === 'Link'
          ? `[${text}](https://)`
          : text
              .split('\n')
              .map((line) => `${style === 'Heading' ? '## ' : '- '}${line}`)
              .join('\n');
    reviseAuthorDocument(
      sessionId,
      document.path,
      content.slice(0, startOffset) + replacement + content.slice(endOffset),
    );
    setAuthorRegionCandidate(sessionId, undefined);
    setError(undefined);
  };
  const tools = [
    {
      label: 'Region',
      glyph: '⌗',
      action: () => setAuthorToolMode(sessionId, activeTool === 'mark' ? 'select' : 'mark'),
      active: activeTool === 'mark',
    },
    ...(kind === 'markdown'
      ? [
          { label: 'Bold', glyph: 'B', action: () => format('Bold') },
          { label: 'Heading', glyph: 'H', action: () => format('Heading') },
          { label: 'Link', glyph: '↗', action: () => format('Link') },
          { label: 'List', glyph: '≡', action: () => format('List') },
        ]
      : []),
    { label: 'Comment', glyph: '□', action: () => setAuthorToolMode(sessionId, 'mark') },
  ];
  return (
    <section data-testid="author-tool-palette" className="space-y-2 border-b border-doom-border-soft pb-3">
      <div className="flex justify-between text-sm text-doom-dim">
        <h3 className="font-bold tracking-widest">TOOLS</h3>
        <span>focused tab</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {tools.map((tool) => (
          <Button
            key={tool.label}
            size="md"
            variant="outline"
            aria-label={tool.label === 'Region' ? 'mark region' : tool.label}
            aria-pressed={tool.active}
            onClick={tool.action}
            className={`min-h-11 min-w-11 gap-1.5 rounded border text-base [@media(pointer:fine)]:min-h-8 sm:text-sm ${tool.active ? 'border-doom-red bg-doom-red/10 text-doom-red hover:bg-doom-red/15' : 'border-doom-border bg-doom-panel text-doom-dim'}`}
          >
            <span aria-hidden="true">{tool.glyph}</span>
            {tool.label}
          </Button>
        ))}
      </div>
      <p className="text-base leading-normal text-doom-dim sm:text-sm">
        {activeTool === 'mark'
          ? 'Drag over the document to mark a region.'
          : 'Choose Region to mark an area for a comment.'}
      </p>
      {error ? <output className="block text-base text-doom-red">{error}</output> : null}
    </section>
  );
}
