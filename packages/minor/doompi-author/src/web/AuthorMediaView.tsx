import { MediaPreview, type MediaPreviewController, type PdfPreviewController } from '@agimon-ai/doompi-web-components';
import { useRef, useState, type PointerEvent } from 'react';
import { normalizedAuthorRectangle } from './authorRegions.ts';
import type { AuthorNativeAnchor, AuthorToolMode } from './authorViewportTypes.ts';
import {
  authorSessionWorkspace,
  setAuthorRegionCandidate,
  type AuthorWorkspaceDocument,
} from './authorWorkspaceStore.ts';

/** Marks source media. Native playback and page controls remain usable in select mode. */
export function AuthorMediaView({
  sessionId,
  document: source,
  activeTool,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  activeTool: AuthorToolMode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<MediaPreviewController>(null);
  const pdf = useRef<PdfPreviewController>(null);
  const start = useRef<
    { x: number; y: number; element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement } | undefined
  >(undefined);
  const [error, setError] = useState<string>();
  const mark = async (event: PointerEvent<HTMLDivElement>) => {
    const drag = start.current;
    start.current = undefined;
    if (!drag) return;
    const bounds = drag.element.getBoundingClientRect();
    const rect = normalizedAuthorRectangle(bounds, {
      left: drag.x,
      top: drag.y,
      right: event.clientX,
      bottom: event.clientY,
    });
    if (!rect) return;
    const focused = authorSessionWorkspace(sessionId).focusedDocument;
    if (!focused || focused.path !== source.path) return;
    let anchor: AuthorNativeAnchor;
    let blob: Blob | null = null;
    let thumbnailUrl: string | undefined;
    try {
      if (drag.element instanceof HTMLImageElement) {
        const image = drag.element;
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image is not ready.');
        anchor = { kind: 'image-rect', rect, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      } else if (source.kind === 'pdf') {
        const page = pdf.current?.getState();
        if (!page?.sourceWidth) throw new Error('PDF page is not ready.');
        anchor = { kind: 'pdf-page-rect', page: page.page, rect };
        blob = await pdf.current!.capturePage();
      } else {
        const frame = await video.current?.captureFrame();
        if (!frame) throw new Error('Video frame is not ready.');
        anchor = {
          kind: 'video-time-rect',
          rect,
          timeSeconds: frame.timeSeconds,
          intrinsicWidth: frame.width,
          intrinsicHeight: frame.height,
        };
        blob = frame.blob;
      }
      if (!blob) throw new Error('Unable to capture selected media.');
      if (authorSessionWorkspace(sessionId).focusedDocument?.generation !== focused.generation) return;
      thumbnailUrl = URL.createObjectURL(blob);
      setAuthorRegionCandidate(sessionId, {
        documentPath: source.path,
        revision: source.version,
        sourceSha256: source.sourceSha256,
        anchor,
        viewport: { width: bounds.width, height: bounds.height },
        thumbnailUrl,
        createdAt: Date.now(),
      });
      setError(undefined);
    } catch (reason) {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div
      ref={host}
      className="min-h-0 flex-1 overflow-auto p-4"
      onPointerDownCapture={(event) => {
        if (activeTool === 'select' || event.button !== 0) return;
        const element = event.target;
        if (
          !(
            element instanceof HTMLImageElement ||
            element instanceof HTMLVideoElement ||
            element instanceof HTMLCanvasElement
          )
        )
          return;
        event.preventDefault();
        start.current = { x: event.clientX, y: event.clientY, element };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => void mark(event)}
      onPointerCancel={() => {
        start.current = undefined;
      }}
    >
      {source.kind === 'image' ? (
        <img src={source.mediaUrl} alt={source.path} draggable={false} className="max-w-full" />
      ) : (
        <MediaPreview
          src={source.mediaUrl ?? ''}
          path={source.path}
          kind={source.kind === 'pdf' ? 'pdf' : source.kind === 'video' ? 'video' : 'download'}
          controllerRef={video}
          pdfControllerRef={pdf}
          data-testid="author-media"
        />
      )}
      {error ? <output className="text-[10px] text-doom-red">{error}</output> : null}
    </div>
  );
}
