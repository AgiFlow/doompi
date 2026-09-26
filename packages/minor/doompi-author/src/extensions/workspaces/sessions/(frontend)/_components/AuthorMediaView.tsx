import {
  Button,
  MediaPreview,
  type MediaPlaybackState,
  type MediaPreviewController,
  type PdfPreviewController,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

import { registerAuthorGridResolver } from '../_lib/authorGrid';
import { loadAuthorMedia } from '../_lib/authorMedia';
import { appendAuthorStrokePoint, authorStrokeBounds, normalizedAuthorRectangle } from '../_lib/authorRegions';
import type { AuthorDisplayedRegion, AuthorNativeAnchor, AuthorToolMode } from '../_lib/authorViewportTypes';
import {
  authorSessionWorkspace,
  setAuthorRegionCandidate,
  setAuthorToolMode,
  type AuthorSessionWorkspace,
  type AuthorWorkspaceDocument,
} from '../_lib/authorWorkspaceStore';
import { AuthorVideoControls } from './AuthorVideoControls';

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
    | {
        x: number;
        y: number;
        pointerId: number;
        mode: 'mark' | 'comment' | 'draw';
        points: readonly { x: number; y: number }[];
        element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
      }
    | undefined
  >(undefined);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const pinch = useRef<{ distance: number; zoom: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [stroke, setStroke] = useState<readonly { x: number; y: number }[]>();
  const [pdfPlane, setPdfPlane] = useState<{ left: number; top: number; width: number; height: number }>();
  const [playback, setPlayback] = useState<MediaPlaybackState>({ playing: false, currentTime: 0, duration: 0 });
  const [frameReady, setFrameReady] = useState(false);
  const [selection, setSelection] = useState<{
    path: string;
    rect?: NonNullable<ReturnType<typeof normalizedAuthorRectangle>>;
    point?: { x: number; y: number };
  }>();
  const [error, setError] = useState<string>();
  const [media, setMedia] = useState<{ source: string; url: string }>();
  useEffect(() => {
    start.current = undefined;
    pointers.current.clear();
    pinch.current = undefined;
    pan.current = undefined;
    setStroke(undefined);
    setSelection(undefined);
    setZoom(1);
  }, [source.path, source.version, source.sourceSha256, source.mediaUrl]);
  useEffect(() => {
    start.current = undefined;
    setStroke(undefined);
    pointers.current.clear();
    pinch.current = undefined;
    pan.current = undefined;
  }, [activeTool]);
  const mediaUrl = media?.source === source.mediaUrl ? media?.url : undefined;
  useEffect(() => {
    if (source.kind !== 'pdf' || mediaUrl === undefined) return;
    const container = host.current;
    if (container === null) return;
    const update = () => {
      const canvas = container.querySelector('canvas');
      const wrapper = container.querySelector('[data-testid="author-media"]');
      if (!canvas || !wrapper) return;
      const bounds = canvas.getBoundingClientRect();
      const outer = wrapper.getBoundingClientRect();
      const next = {
        left: (bounds.left - outer.left) / zoom,
        top: (bounds.top - outer.top) / zoom,
        width: bounds.width / zoom,
        height: bounds.height / zoom,
      };
      setPdfPlane((current) =>
        current &&
        Object.keys(next).every(
          (key) => Math.abs(current[key as keyof typeof next] - next[key as keyof typeof next]) < 0.01,
        )
          ? current
          : next,
      );
    };
    const resize = new ResizeObserver(update);
    const mutation = new MutationObserver(() => {
      const canvas = container.querySelector('canvas');
      if (canvas) resize.observe(canvas);
      update();
    });
    mutation.observe(container, { childList: true, subtree: true });
    const canvas = container.querySelector('canvas');
    if (canvas) resize.observe(canvas);
    update();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [source.kind, mediaUrl, zoom]);
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
    if (!drag || drag.pointerId !== event.pointerId || pinch.current !== undefined) return;
    start.current = undefined;
    const bounds = drag.element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const point = {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
    const points = drag.mode === 'draw' ? appendAuthorStrokePoint(drag.points, point) : undefined;
    const rect =
      drag.mode === 'draw'
        ? authorStrokeBounds(points ?? [])
        : drag.mode === 'mark'
          ? normalizedAuthorRectangle(bounds, {
              left: drag.x,
              top: drag.y,
              right: event.clientX,
              bottom: event.clientY,
            })
          : undefined;
    if (drag.mode !== 'comment' && !rect) return;
    setStroke(undefined);
    setSelection(
      drag.mode === 'draw'
        ? undefined
        : drag.mode === 'mark'
          ? { path: source.path, rect: rect! }
          : { path: source.path, point },
    );
    const focused = authorSessionWorkspace(sessionId).focusedDocument;
    if (!focused || focused.path !== source.path) return;
    let anchor: AuthorNativeAnchor;
    let blob: Blob | null = null;
    let thumbnailUrl: string | undefined;
    try {
      if (drag.element instanceof HTMLImageElement) {
        const image = drag.element;
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image is not ready.');
        anchor =
          drag.mode !== 'comment'
            ? { kind: 'image-rect', rect: rect!, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }
            : { kind: 'image-point', point, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
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
        anchor =
          drag.mode !== 'comment'
            ? { kind: 'pdf-page-rect', page: page.page, rect: rect! }
            : { kind: 'pdf-page-point', page: page.page, point };
        blob = await pdf.current!.capturePage();
        if (pdf.current?.getState().page !== page.page) return;
      } else {
        const frame = await video.current?.captureFrame();
        if (!frame) throw new Error('Video frame is not ready.');
        anchor =
          drag.mode !== 'comment'
            ? {
                kind: 'video-time-rect',
                rect: rect!,
                timeSeconds: frame.timeSeconds,
                intrinsicWidth: frame.width,
                intrinsicHeight: frame.height,
              }
            : {
                kind: 'video-time-point',
                point,
                timeSeconds: frame.timeSeconds,
                intrinsicWidth: frame.width,
                intrinsicHeight: frame.height,
              };
        blob = frame.blob;
        if (
          Math.abs((video.current?.getState().currentTime ?? -1) - frame.timeSeconds) > 0.1 ||
          video.current?.isFrameReady() === false
        )
          return;
      }
      if (!blob) throw new Error('Unable to capture selected media.');
      if (authorSessionWorkspace(sessionId).focusedDocument?.generation !== focused.generation) return;
      thumbnailUrl = URL.createObjectURL(blob);
      setAuthorRegionCandidate(sessionId, {
        documentPath: source.path,
        revision: source.version,
        sourceSha256: source.sourceSha256,
        mode: drag.mode === 'comment' ? 'point' : 'region',
        anchor,
        ...(points === undefined ? {} : { stroke: points }),
        viewport: { width: bounds.width, height: bounds.height },
        thumbnailUrl,
        evidence: blob,
        createdAt: Date.now(),
      });
      setError(undefined);
    } catch (reason) {
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const strokeOverlay = (points: readonly { x: number; y: number }[] | undefined, ordinal?: number) =>
    points === undefined ? null : (
      <svg
        data-testid={ordinal === undefined ? 'author-media-stroke-selection' : 'author-media-stroke'}
        data-author-stroke={ordinal}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
      >
        <polyline
          points={points.map((point) => `${String(point.x * 1000)},${String(point.y * 1000)}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={ordinal === undefined ? 'text-doom-red' : 'text-doom-yellow'}
        />
      </svg>
    );
  const selected = selection?.path === source.path ? selection.rect : undefined;
  const selectedPoint = selection?.path === source.path ? selection.point : undefined;
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
  const pointPin = (ordinal: number | undefined, point: { x: number; y: number }, key: string) => (
    <span
      key={key}
      data-author-point={ordinal}
      data-testid={ordinal === undefined ? 'author-media-point-selection' : undefined}
      className={`pointer-events-none absolute z-10 flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 px-1 text-2xs font-bold ${ordinal === undefined ? 'border-white bg-doom-red text-white' : 'border-doom-deep bg-doom-yellow text-doom-deep'}`}
      style={{ left: `${String(point.x * 100)}%`, top: `${String(point.y * 100)}%` }}
    >
      {ordinal ?? '•'}
    </span>
  );
  const pointSelectionOverlay = selectedPoint === undefined ? null : pointPin(undefined, selectedPoint, 'selection');
  return (
    <div
      ref={host}
      className="min-h-0 flex-1 overflow-auto p-4"
      style={{ cursor: activeTool === 'draw' || activeTool === 'mark' ? 'crosshair' : undefined }}
      onPointerMove={(event) => {
        if (pointers.current.has(event.pointerId))
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinch.current !== undefined && pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()];
          const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          if (pinch.current.distance > 0)
            setZoom(Math.min(8, Math.max(1, (pinch.current.zoom * distance) / pinch.current.distance)));
          return;
        }
        if (pan.current !== undefined && activeTool === 'pan') {
          const element = host.current;
          if (element) {
            element.scrollLeft = pan.current.left + pan.current.x - event.clientX;
            element.scrollTop = pan.current.top + pan.current.y - event.clientY;
          }
          return;
        }
        const drag = start.current;
        if (drag?.pointerId !== event.pointerId) return;
        if (drag.mode === 'draw') {
          const bounds = drag.element.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          drag.points = appendAuthorStrokePoint(drag.points, {
            x: (event.clientX - bounds.left) / bounds.width,
            y: (event.clientY - bounds.top) / bounds.height,
          });
          setStroke(drag.points);
          return;
        }
        if (drag.mode !== 'mark') return;
        const rect = normalizedAuthorRectangle(drag.element.getBoundingClientRect(), {
          left: drag.x,
          top: drag.y,
          right: event.clientX,
          bottom: event.clientY,
        });
        setSelection(rect === null ? undefined : { path: source.path, rect });
      }}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) return;
        const element = event.target;
        if (
          !(
            element instanceof HTMLImageElement ||
            element instanceof HTMLVideoElement ||
            element instanceof HTMLCanvasElement
          )
        )
          return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 2) {
          start.current = undefined;
          setStroke(undefined);
          setSelection(undefined);
          pan.current = undefined;
          const [a, b] = [...pointers.current.values()];
          pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (activeTool === 'pan') {
          const container = host.current;
          if (container)
            pan.current = { x: event.clientX, y: event.clientY, left: container.scrollLeft, top: container.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if ((activeTool !== 'mark' && activeTool !== 'comment' && activeTool !== 'draw') || pendingCandidate) return;
        event.preventDefault();
        setSelection(undefined);
        if (element instanceof HTMLVideoElement) {
          if (video.current?.isFrameReady?.() === false) {
            setError('Wait for the selected frame to finish loading.');
            return;
          }
          video.current?.pause();
        }
        const bounds = element.getBoundingClientRect();
        start.current = {
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId,
          mode: activeTool,
          element,
          points:
            activeTool === 'draw'
              ? [{ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }]
              : [],
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        if (pinch.current === undefined && pan.current === undefined) void mark(event);
        pointers.current.delete(event.pointerId);
        pan.current = undefined;
        if (pointers.current.size < 2) pinch.current = undefined;
      }}
      onPointerCancel={(event) => {
        pointers.current.delete(event.pointerId);
        pinch.current = undefined;
        pan.current = undefined;
        start.current = undefined;
        setStroke(undefined);
        setSelection(undefined);
      }}
      onLostPointerCapture={() => {
        start.current = undefined;
        pan.current = undefined;
        setStroke(undefined);
      }}
    >
      <div
        className="sticky top-0 z-20 mb-2 flex items-center gap-2 bg-doom-bg py-1"
        role="group"
        aria-label="Canvas zoom"
      >
        <Button
          size="md"
          variant="outline"
          aria-label="Zoom out"
          className="min-h-11 min-w-11"
          onClick={() => setZoom((current) => Math.max(1, current / 1.5))}
        >
          −
        </Button>
        <output className="text-sm text-doom-dim">{Math.round(zoom * 100)}%</output>
        <Button
          size="md"
          variant="outline"
          aria-label="Zoom in"
          className="min-h-11 min-w-11"
          onClick={() => setZoom((current) => Math.min(8, current * 1.5))}
        >
          +
        </Button>
        <Button
          size="md"
          variant="outline"
          aria-label="Fit canvas"
          className="min-h-11"
          onClick={() => {
            setZoom(1);
            if (host.current) {
              host.current.scrollLeft = 0;
              host.current.scrollTop = 0;
            }
          }}
        >
          Fit
        </Button>
      </div>
      {mediaUrl === undefined ? (
        <p className="text-doom-dim">{error === undefined ? 'Loading media...' : 'Media unavailable.'}</p>
      ) : source.kind === 'image' ? (
        <div
          className="relative inline-block max-w-full"
          style={{ zoom, touchAction: activeTool === 'select' ? 'auto' : 'none' }}
        >
          <img ref={image} src={mediaUrl} alt={source.path} draggable={false} className="block max-w-full" />
          {selectionOverlay}
          {pointSelectionOverlay}
          {strokeOverlay(stroke)}
          {displayedRegions.flatMap(({ ordinal, region }) => {
            if (region.stroke !== undefined)
              return [
                <div key={region.id} className="pointer-events-none absolute inset-0">
                  {strokeOverlay(region.stroke, ordinal)}
                  {pointPin(ordinal, region.stroke[0]!, `label:${region.id}`)}
                </div>,
              ];
            if (region.anchor.kind === 'image-point') return [pointPin(ordinal, region.anchor.point, region.id)];
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
        <div
          className="relative w-fit max-w-full"
          style={{ zoom, touchAction: activeTool === 'select' ? 'auto' : 'none' }}
        >
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
          <div
            className="pointer-events-none absolute"
            style={
              source.kind === 'pdf'
                ? pdfPlane === undefined
                  ? { display: 'none' }
                  : { left: pdfPlane.left, top: pdfPlane.top, width: pdfPlane.width, height: pdfPlane.height }
                : { inset: 0 }
            }
          >
            {selectionOverlay}
            {pointSelectionOverlay}
            {strokeOverlay(stroke)}
            {displayedRegions.map(({ ordinal, region }) => {
              if (region.stroke !== undefined) {
                const anchor = region.anchor;
                if (
                  source.kind === 'pdf' &&
                  (anchor.kind !== 'pdf-page-rect' || anchor.page !== pdf.current?.getState().page)
                )
                  return null;
                if (
                  source.kind === 'video' &&
                  (anchor.kind !== 'video-time-rect' ||
                    playback.playing ||
                    Math.abs(anchor.timeSeconds - playback.currentTime) > 0.1)
                )
                  return null;
                return (
                  <div key={region.id} className="pointer-events-none absolute inset-0">
                    {strokeOverlay(region.stroke, ordinal)}
                    {pointPin(ordinal, region.stroke[0]!, `label:${region.id}`)}
                  </div>
                );
              }
              if (source.kind === 'pdf') {
                if (region.anchor.kind !== 'pdf-page-point' && region.anchor.kind !== 'pdf-page-rect') return null;
                if (region.anchor.page !== pdf.current?.getState().page) return null;
                if (region.anchor.kind === 'pdf-page-point') return pointPin(ordinal, region.anchor.point, region.id);
                const { rect } = region.anchor;
                return (
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
                    <span className="bg-doom-yellow text-doom-deep">{ordinal}</span>
                  </div>
                );
              }
              if (source.kind !== 'video' || playback.playing) return null;
              if (
                region.anchor.kind === 'video-time-point' &&
                Math.abs(region.anchor.timeSeconds - playback.currentTime) <= 0.1
              ) {
                return pointPin(ordinal, region.anchor.point, region.id);
              }
              if (
                region.anchor.kind !== 'video-time-rect' ||
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
            })}
          </div>
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
