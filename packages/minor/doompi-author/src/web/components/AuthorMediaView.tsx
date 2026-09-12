import {
  MediaPreview,
  type MediaPlaybackState,
  type MediaPreviewController,
  type PdfPreviewController,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { AuthorVideoControls } from './AuthorVideoControls';
import { loadAuthorMedia } from '../api/authorMedia';
import { registerAuthorGridResolver } from '../lib/authorGrid';
import { normalizedAuthorRectangle } from '../lib/authorRegions';
import type { AuthorDisplayedRegion, AuthorNativeAnchor, AuthorToolMode } from '../lib/authorViewportTypes';
import {
  authorSessionWorkspace,
  setAuthorRegionCandidate,
  setAuthorToolMode,
  type AuthorSessionWorkspace,
  type AuthorWorkspaceDocument,
} from '../stores/authorWorkspaceStore';

/** Marks source media. Native playback and page controls remain usable in select mode. */
export function AuthorMediaView({
  sessionId,
  document: source,
  activeTool,
  displayedRegions,
  pendingCandidate = false,
  seekRequest,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  activeTool: AuthorToolMode;
  displayedRegions: readonly AuthorDisplayedRegion[];
  pendingCandidate?: boolean;
  seekRequest?: AuthorSessionWorkspace['videoSeekRequest'];
}) {
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<MediaPreviewController>(null);
  const pdf = useRef<PdfPreviewController>(null);
  const start = useRef<
    { x: number; y: number; element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement } | undefined
  >(undefined);
  const [playback, setPlayback] = useState<MediaPlaybackState>({ playing: false, currentTime: 0, duration: 0 });
  const [frameReady, setFrameReady] = useState(false);
  const [selection, setSelection] = useState<{
    path: string;
    rect: NonNullable<ReturnType<typeof normalizedAuthorRectangle>>;
  }>();
  const [error, setError] = useState<string>();
  const [media, setMedia] = useState<{ source: string; url: string }>();
  const mediaUrl = media?.source === source.mediaUrl ? media?.url : undefined;
  useEffect(() => {
    if (source.mediaUrl === undefined) return;
    const input = source.mediaUrl;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setError(undefined);
    void loadAuthorMedia(input, controller.signal)
      .then((asset) => {
        if (controller.signal.aborted) {
          asset.dispose();
          return;
        }
        dispose = () => asset.dispose();
        setMedia({ source: input, url: asset.url });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [source.mediaUrl]);
  const seek = (seconds: number) => {
    if (authorSessionWorkspace(sessionId).candidate || !Number.isFinite(seconds)) return;
    const player = video.current;
    if (!player) return;
    player.pause();
    setAuthorToolMode(sessionId, 'select');
    setSelection(undefined);
    if (player.getState().currentTime === seconds) return;
    setFrameReady(false);
    player.seek(seconds);
  };
  useEffect(() => {
    if (
      seekRequest?.path === source.path &&
      seekRequest.generation === authorSessionWorkspace(sessionId).focusedDocument?.generation
    ) {
      seek(seekRequest.timeSeconds);
    }
  }, [seekRequest]);
  useEffect(() => {
    if (!pendingCandidate && start.current === undefined) setSelection(undefined);
  }, [pendingCandidate]);
  useEffect(
    () =>
      registerAuthorGridResolver(sessionId, (cell, geometry) => {
        const target = image.current;
        if (source.kind !== 'image' || target === null || target.naturalWidth === 0 || target.naturalHeight === 0)
          return undefined;
        const { originX = 0, originY = 0, width, height } = geometry.viewport;
        const cellBounds = {
          left: originX + cell.rect.x * width,
          top: originY + cell.rect.y * height,
          right: originX + (cell.rect.x + cell.rect.width) * width,
          bottom: originY + (cell.rect.y + cell.rect.height) * height,
        };
        const bounds = target.getBoundingClientRect();
        const left = Math.max(bounds.left, cellBounds.left);
        const top = Math.max(bounds.top, cellBounds.top);
        const right = Math.min(bounds.right, cellBounds.right);
        const bottom = Math.min(bounds.bottom, cellBounds.bottom);
        if (right <= left || bottom <= top || bounds.width <= 0 || bounds.height <= 0) return undefined;
        return {
          anchor: {
            kind: 'image-rect',
            rect: {
              x: (left - bounds.left) / bounds.width,
              y: (top - bounds.top) / bounds.height,
              width: (right - left) / bounds.width,
              height: (bottom - top) / bounds.height,
            },
            naturalWidth: target.naturalWidth,
            naturalHeight: target.naturalHeight,
          },
        };
      }),
    [sessionId, source.kind, source.path, source.version],
  );
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
    setSelection({ path: source.path, rect });
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
  const selected = selection?.path === source.path ? selection.rect : undefined;
  const selectionOverlay =
    selected === undefined ? null : (
      <div
        data-testid="author-media-selection"
        className="pointer-events-none absolute border-2 border-doom-red bg-doom-red/10"
        style={{
          left: `${selected.x * 100}%`,
          top: `${selected.y * 100}%`,
          width: `${selected.width * 100}%`,
          height: `${selected.height * 100}%`,
        }}
      />
    );
  return (
    <div
      ref={host}
      className="min-h-0 flex-1 overflow-auto p-4"
      style={{
        touchAction: activeTool === 'select' ? 'auto' : 'none',
        cursor: activeTool === 'select' ? undefined : 'crosshair',
      }}
      onPointerMove={(event) => {
        const drag = start.current;
        if (drag === undefined) return;
        const rect = normalizedAuthorRectangle(drag.element.getBoundingClientRect(), {
          left: drag.x,
          top: drag.y,
          right: event.clientX,
          bottom: event.clientY,
        });
        setSelection(rect === null ? undefined : { path: source.path, rect });
      }}
      onPointerDownCapture={(event) => {
        if (activeTool === 'select' || event.button !== 0 || pendingCandidate) return;
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
        setSelection(undefined);
        if (element instanceof HTMLVideoElement) {
          if (video.current?.isFrameReady?.() === false) {
            setError('Wait for the selected frame to finish loading.');
            return;
          }
          video.current?.pause();
        }
        start.current = { x: event.clientX, y: event.clientY, element };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => void mark(event)}
      onPointerCancel={() => {
        start.current = undefined;
        setSelection(undefined);
      }}
    >
      {mediaUrl === undefined ? (
        <p className="text-doom-dim">{error === undefined ? 'Loading media...' : 'Media unavailable.'}</p>
      ) : source.kind === 'image' ? (
        <div className="relative inline-block max-w-full">
          <img ref={image} src={mediaUrl} alt={source.path} draggable={false} className="block max-w-full" />
          {selectionOverlay}
          {displayedRegions.flatMap(({ ordinal, region }) => {
            if (region.anchor.kind !== 'image-rect') return [];
            const { rect } = region.anchor;
            return [
              <div
                key={region.id}
                data-author-region={ordinal}
                className="pointer-events-none absolute border border-doom-yellow bg-doom-yellow/10"
                style={{
                  left: `${String(rect.x * 100)}%`,
                  top: `${String(rect.y * 100)}%`,
                  width: `${String(rect.width * 100)}%`,
                  height: `${String(rect.height * 100)}%`,
                }}
              >
                <span className="absolute -left-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-doom-yellow px-1 text-2xs font-bold text-doom-deep">
                  {ordinal}
                </span>
              </div>,
            ];
          })}
        </div>
      ) : (
        <div className="relative w-fit max-w-full">
          <MediaPreview
            src={mediaUrl}
            path={source.path}
            kind={source.kind === 'pdf' ? 'pdf' : source.kind === 'video' ? 'video' : 'download'}
            controllerRef={video}
            pdfControllerRef={pdf}
            data-testid="author-media"
            videoControls={false}
            onPlaybackStateChange={(state) => {
              setPlayback(state);
              setFrameReady(video.current?.isFrameReady() ?? false);
              if (state.playing) setSelection(undefined);
            }}
          />
          {source.kind === 'video' ? selectionOverlay : null}
          {source.kind === 'video'
            ? displayedRegions.map(({ ordinal, region }) => {
                if (
                  region.anchor.kind !== 'video-time-rect' ||
                  playback.playing ||
                  Math.abs(region.anchor.timeSeconds - playback.currentTime) > 0.1
                )
                  return null;
                const { rect } = region.anchor;
                return (
                  <div
                    key={region.id}
                    data-author-region={ordinal}
                    className="pointer-events-none absolute border border-doom-yellow bg-doom-yellow/10"
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                  >
                    <span className="bg-doom-yellow text-doom-deep">{ordinal}</span>
                  </div>
                );
              })
            : null}
        </div>
      )}
      {source.kind === 'video' ? (
        <AuthorVideoControls
          playback={playback}
          ready={frameReady}
          locked={pendingCandidate}
          marking={activeTool === 'mark'}
          onSeek={seek}
          onToggle={() => {
            setAuthorToolMode(sessionId, 'select');
            setSelection(undefined);
            if (playback.playing) video.current?.pause();
            else void video.current?.play().catch((reason: unknown) => setError(String(reason)));
          }}
          onAnnotate={() => {
            video.current?.pause();
            setAuthorToolMode(sessionId, 'mark');
          }}
        />
      ) : null}
      {error ? <output className="text-base text-doom-red">{error}</output> : null}
    </div>
  );
}
