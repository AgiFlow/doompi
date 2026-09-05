import { useEffect, useRef } from 'react';
import {
  AUTHOR_GRID_COLUMNS,
  AUTHOR_GRID_SIZE,
  clearAuthorGridGeometry,
  updateAuthorGridGeometry,
} from './authorGrid.ts';
import type { AuthorWorkspaceDocument } from './authorWorkspaceStore.ts';

export function autonomousVoiceGridVisible(statuses: Readonly<Record<string, string>>): boolean {
  return statuses['doom-voice']?.trimStart().startsWith('voice auto:') === true;
}

export function AuthorGridOverlay({
  sessionId,
  document,
  visible,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current?.parentElement;
    if (!visible || element === null || element === undefined) {
      clearAuthorGridGeometry(sessionId);
      return;
    }
    const publish = () => {
      const bounds = element.getBoundingClientRect();
      updateAuthorGridGeometry(sessionId, {
        documentPath: document.path,
        revision: document.version,
        sourceSha256: document.sourceSha256,
        viewport: {
          width: bounds.width,
          height: bounds.height,
          originX: bounds.left,
          originY: bounds.top,
          scrollX: element.scrollLeft,
          scrollY: element.scrollTop,
          zoom: window.devicePixelRatio,
        },
      });
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    element.addEventListener('scroll', publish, { passive: true, capture: true });
    window.addEventListener('focus', publish);
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', publish, true);
      window.removeEventListener('focus', publish);
      clearAuthorGridGeometry(sessionId);
    };
  }, [document.path, document.sourceSha256, document.version, sessionId, visible]);
  if (!visible) return null;
  return (
    <div
      ref={host}
      data-testid="author-grid"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 grid grid-cols-8 grid-rows-8"
    >
      {Array.from({ length: AUTHOR_GRID_SIZE * AUTHOR_GRID_SIZE }, (_, index) => {
        const column = index % AUTHOR_GRID_SIZE;
        const row = Math.floor(index / AUTHOR_GRID_SIZE);
        return (
          <div key={index} className="relative border border-doom-red/25">
            <span className="absolute left-1 top-0.5 rounded bg-doom-deep/80 px-1 text-[8px] font-bold text-doom-red">
              {AUTHOR_GRID_COLUMNS[column]}
              {row + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}
