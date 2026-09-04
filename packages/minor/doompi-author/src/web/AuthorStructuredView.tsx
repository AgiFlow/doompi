import { Button } from '@agimon-ai/doompi-web-components';
import type { DocumentFragment } from '../types/structuredDocuments.ts';
import {
  reviseAuthorFragment,
  setAuthorRegionCandidate,
  type AuthorWorkspaceDocument,
} from './authorWorkspaceStore.ts';

export function AuthorStructuredView({
  sessionId,
  document,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
}) {
  const cells = document.kind === 'csv' || document.kind === 'xlsx';
  const groups = new Map<string, DocumentFragment[]>();
  for (const fragment of document.fragments ?? []) {
    const key = cells
      ? document.kind === 'csv'
        ? fragment.location.split(',')[0]!
        : fragment.location.replace(/![A-Z]+(\d+)$/, '!row $1')
      : fragment.location;
    const group = groups.get(key) ?? [];
    group.push(fragment);
    groups.set(key, group);
  }
  return (
    <div data-testid="author-structured" className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      {!cells ? <p className="text-[10px] text-doom-faint">Slide text view, not a layout-faithful rendering.</p> : null}
      {[...groups].map(([location, fragments]) => (
        <section key={location} className="space-y-1">
          <h3 className="text-[10px] text-doom-faint">{location}</h3>
          <div className={cells ? 'flex gap-1' : 'space-y-2'}>
            {fragments.map((fragment) => (
              <div key={fragment.id} className={cells ? 'w-40 shrink-0' : ''}>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const slide = Number(fragment.location.match(/(?:slide\s*|slides\/slide)(\d+)/)?.[1]);
                    if (!cells && !Number.isSafeInteger(slide)) return;
                    setAuthorRegionCandidate(sessionId, {
                      documentPath: document.path,
                      revision: document.version,
                      sourceSha256: document.sourceSha256,
                      quote: fragment.text,
                      anchor: cells
                        ? { kind: 'cell', fragmentId: fragment.id, location: fragment.location }
                        : { kind: 'slide-element', fragmentId: fragment.id, location: fragment.location, slide },
                      viewport: { width: bounds.width, height: bounds.height },
                      createdAt: Date.now(),
                    });
                  }}
                >
                  mark {fragment.location}
                </Button>
                <textarea
                  aria-label={fragment.location}
                  value={fragment.text}
                  readOnly={fragment.readOnly === true}
                  className="w-full rounded border border-doom-border bg-doom-deep p-2 text-[11px] text-doom-text"
                  onChange={(event) => reviseAuthorFragment(sessionId, document.path, fragment.id, event.target.value)}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
