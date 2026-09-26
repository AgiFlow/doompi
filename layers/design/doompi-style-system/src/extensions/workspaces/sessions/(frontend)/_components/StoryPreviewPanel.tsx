import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type {
  BuildStoryPreviewRequest,
  BuildStoryPreviewView,
  ExportStoryPreviewImageView,
  StoryPreviewMetadataView,
  StoryPreviewSeed,
} from '../../../../../types/previewApi';
import { buildPreview, disposePreview, exportPreviewImage, storyMetadata } from '../_lib/previewApi';
import {
  isolatedPreviewHtml,
  normalizedAnnotationRect,
  previewAnnotationLocation,
  type PreviewAnnotationRect,
  type PreviewPoint,
} from '../_lib/previewFrame';

function imageDownload(data: string, storyExport: string): void {
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${data}`;
  link.download = `${storyExport.replace(/[^A-Za-z0-9_-]/g, '-')}.png`;
  link.click();
}

function point(event: ReactPointerEvent<HTMLElement>): PreviewPoint {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
}

interface StoryPreviewSource {
  path: string;
  hasUnsavedChanges: boolean;
  kind?: string;
  revision?: number;
  sourceSha256?: string;
}

interface StoryPreviewIdentity {
  version: 1;
  provider: string;
  projectPath: string;
  storyPath: string;
  storyExport: string;
  buildRevision: string;
  viewport: { width: number; height: number };
  sources: readonly { path: string; sha256: string }[];
}

interface StoryPreviewPanelProps extends WebPluginSlotProps {
  seed?: StoryPreviewSeed;
  source?: StoryPreviewSource;
  activeTool?: 'select' | 'mark' | 'comment' | 'draw' | 'pan';
  displayedAnnotations?: readonly {
    ordinal: number;
    mode: 'region' | 'point';
    point: PreviewPoint;
    rect?: PreviewAnnotationRect;
    stroke?: readonly PreviewPoint[];
  }[];
  pendingCandidate?: boolean;
  onAnnotationCandidate?: (candidate: {
    mode: 'region' | 'point';
    point: PreviewPoint;
    rect?: PreviewAnnotationRect;
    stroke?: readonly PreviewPoint[];
    preview: StoryPreviewIdentity;
    evidence: Blob;
    thumbnailUrl: string;
  }) => void;
}

function preferredExport(exports: readonly StoryPreviewMetadataView['exports'][number][]): string {
  return exports.find((entry) => entry.exportName === 'Playground')?.exportName ?? exports[0]?.exportName ?? '';
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function StoryPreviewPanel({
  sessionId,
  submitCapture,
  seed,
  source,
  activeTool = 'select',
  displayedAnnotations = [],
  pendingCandidate = false,
  onAnnotationCandidate,
}: StoryPreviewPanelProps) {
  const contextualSource = source ?? seed?.source;
  const sourcePath = contextualSource?.path ?? '';
  const sourceDirty = contextualSource?.hasUnsavedChanges === true;
  const sourceRevision = contextualSource?.revision ?? 0;
  const sourceSha256 = contextualSource?.sourceSha256 ?? '';
  const contextual = contextualSource !== undefined;
  const [appPath, setAppPath] = useState(contextual ? '' : '.');
  const [storyPath, setStoryPath] = useState(sourcePath);
  const [storyExport, setStoryExport] = useState(contextual ? '' : 'Playground');
  const [storyExports, setStoryExports] = useState<
    readonly StoryPreviewMetadataView['exports'][number][] | undefined
  >();
  const [darkMode, setDarkMode] = useState(false);
  const [preview, setPreview] = useState<BuildStoryPreviewView | undefined>(undefined);
  const [builtRequest, setBuiltRequest] = useState<BuildStoryPreviewRequest | undefined>(undefined);
  const [annotationImage, setAnnotationImage] = useState<ExportStoryPreviewImageView | undefined>(undefined);
  const [annotationStart, setAnnotationStart] = useState<PreviewPoint | undefined>(undefined);
  const [annotationRect, setAnnotationRect] = useState<PreviewAnnotationRect | undefined>(undefined);
  const [feedback, setFeedback] = useState('');
  const [status, setStatus] = useState(
    contextual
      ? sourceDirty
        ? 'Loading story metadata. Preview uses saved source.'
        : 'Loading story metadata…'
      : 'Choose an exact story file and export.',
  );
  const [working, setWorking] = useState(false);
  const generationRef = useRef(0);
  const operationRef = useRef(0);
  const previewRef = useRef<BuildStoryPreviewView | undefined>(undefined);
  const builtRequestRef = useRef<BuildStoryPreviewRequest | undefined>(undefined);
  const workingRef = useRef(false);
  const dirtyRef = useRef(sourceDirty);
  const annotationExportRef = useRef('');
  const [stroke, setStroke] = useState<readonly PreviewPoint[]>([]);
  const [zoom, setZoom] = useState(1);
  const [gesture, setGesture] = useState<number>();
  const pointers = useRef(new Map<number, PreviewPoint>());
  const pinch = useRef<{ distance: number; zoom: number } | undefined>(undefined);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const imageScroll = useRef<HTMLDivElement>(null);

  dirtyRef.current = sourceDirty;

  const request = useMemo<BuildStoryPreviewRequest>(
    () => ({ appPath, storyPath, storyExport, darkMode }),
    [appPath, storyPath, storyExport, darkMode],
  );

  useEffect(() => {
    operationRef.current += 1;
    if (!workingRef.current) return;
    workingRef.current = false;
    setWorking(false);
  }, [request]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    operationRef.current += 1;
    workingRef.current = false;
    setWorking(false);
    setStoryExports(undefined);
    setAppPath(contextual ? '' : '.');
    setStoryPath(sourcePath);
    setStoryExport(contextual ? '' : 'Playground');
    builtRequestRef.current = undefined;
    setBuiltRequest(undefined);
    setAnnotationImage(undefined);
    setAnnotationStart(undefined);
    setAnnotationRect(undefined);
    setStroke([]);
    setZoom(1);
    pointers.current.clear();
    pinch.current = undefined;

    if (sessionId === null || sourcePath === '') {
      setPreview(undefined);
      previewRef.current = undefined;
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }

    const previous = previewRef.current;
    previewRef.current = undefined;
    setPreview(undefined);
    if (previous !== undefined) void disposePreview(sessionId, previous.handle);

    let current = true;
    setStatus(sourceDirty ? 'Loading story metadata. Preview uses saved source.' : 'Loading story metadata…');
    void storyMetadata(sessionId, { storyPath: sourcePath })
      .then((result) => {
        if (!current || generationRef.current !== generation) return;
        if (!result.ok) {
          setStoryExports(undefined);
          setStatus(result.error);
          return;
        }
        const exports = result.metadata.exports;
        setAppPath(result.metadata.appPath);
        setStoryPath(result.metadata.storyPath);
        setStoryExports(exports);
        setStoryExport(preferredExport(exports));
        if (exports.length === 0) {
          setStatus('No story exports were found in this file.');
        } else if (dirtyRef.current) {
          setStatus('Save changes to preview. Preview uses saved source.');
        } else if (exports.length === 1) {
          setStatus('Story found. Building preview…');
        } else {
          setStatus('Story found. Building the Playground export…');
        }
      })
      .catch((reason: unknown) => {
        if (current && generationRef.current === generation) setStatus(errorText(reason));
      });

    return () => {
      current = false;
      if (generationRef.current === generation) generationRef.current += 1;
      operationRef.current += 1;
      const ownedPreview = previewRef.current;
      previewRef.current = undefined;
      if (ownedPreview !== undefined) void disposePreview(sessionId, ownedPreview.handle);
    };
  }, [contextual, sessionId, sourcePath, sourceRevision, sourceSha256]);

  useEffect(() => {
    if (!contextual || !sourceDirty) return;
    setStatus('Save changes to preview. Preview uses saved source.');
  }, [contextual, sourceDirty]);

  const rebuild = useCallback(async (): Promise<boolean> => {
    if (
      sessionId === null ||
      workingRef.current ||
      request.appPath.trim() === '' ||
      request.storyPath.trim() === '' ||
      request.storyExport.trim() === ''
    )
      return false;
    if (dirtyRef.current) {
      setStatus('Save changes to preview. Preview uses saved source.');
      return false;
    }

    const generation = generationRef.current;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const requestSessionId = sessionId;
    workingRef.current = true;
    setWorking(true);
    setStatus('Building preview…');
    try {
      const result = await buildPreview(requestSessionId, request);
      if (generationRef.current !== generation || operationRef.current !== operation) {
        if (result.ok) void disposePreview(requestSessionId, result.preview.handle);
        return false;
      }
      if (!result.ok) {
        setStatus(result.error);
        return false;
      }
      const previous = previewRef.current;
      previewRef.current = result.preview;
      builtRequestRef.current = request;
      setPreview(result.preview);
      setBuiltRequest(request);
      setAnnotationImage(undefined);
      setAnnotationStart(undefined);
      setAnnotationRect(undefined);
      if (previous !== undefined && previous.handle !== result.preview.handle) {
        void disposePreview(requestSessionId, previous.handle);
      }
      setStatus(
        dirtyRef.current
          ? 'Preview ready from saved source. Save changes to refresh.'
          : 'Preview ready. Refresh after source edits.',
      );
      return true;
    } catch (reason: unknown) {
      if (generationRef.current === generation && operationRef.current === operation) setStatus(errorText(reason));
      return false;
    } finally {
      if (generationRef.current === generation && operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
      }
    }
  }, [request, sessionId]);

  useEffect(() => {
    if (
      !contextual ||
      sessionId === null ||
      sourceDirty ||
      storyExports === undefined ||
      storyExport.trim() === '' ||
      appPath.trim() === '' ||
      storyPath.trim() === ''
    )
      return;
    void rebuild();
  }, [appPath, contextual, rebuild, sessionId, sourceDirty, storyExport, storyExports, storyPath]);

  const image = useCallback(async (): Promise<ExportStoryPreviewImageView | undefined> => {
    const currentRequest = builtRequestRef.current;
    if (sessionId === null || workingRef.current || currentRequest === undefined) return undefined;
    const generation = generationRef.current;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const requestSessionId = sessionId;
    workingRef.current = true;
    setWorking(true);
    setStatus('Rendering a fresh source-backed image…');
    try {
      const result = await exportPreviewImage(requestSessionId, currentRequest);
      if (generationRef.current !== generation || operationRef.current !== operation) return undefined;
      if (!result.ok) {
        setStatus(result.error);
        return undefined;
      }
      setStatus('Image rendered from the current source. Transient iframe interactions are not included.');
      return result.image;
    } catch (reason: unknown) {
      if (generationRef.current === generation && operationRef.current === operation) setStatus(errorText(reason));
      return undefined;
    } finally {
      if (generationRef.current === generation && operationRef.current === operation) {
        workingRef.current = false;
        setWorking(false);
      }
    }
  }, [sessionId]);

  async function prepareAnnotation(): Promise<void> {
    const generation = generationRef.current;
    const result = await image();
    if (result === undefined || generationRef.current !== generation) return;
    setAnnotationImage(result);
    setAnnotationRect(undefined);
    setStatus('Annotation image ready. Drag a region or comment on the whole preview.');
  }

  useEffect(() => {
    if (onAnnotationCandidate === undefined) return;
    if (activeTool === 'select') {
      annotationExportRef.current = '';
      setAnnotationImage(undefined);
      setAnnotationStart(undefined);
      setAnnotationRect(undefined);
      return;
    }
    if (
      preview === undefined ||
      annotationImage !== undefined ||
      working ||
      annotationExportRef.current === preview.handle
    )
      return;
    const generation = generationRef.current;
    void image().then((result) => {
      if (result === undefined || generationRef.current !== generation) return;
      annotationExportRef.current = preview.handle;
      setAnnotationImage(result);
      setStatus('Frozen source-backed image ready for Author annotations.');
    });
  }, [activeTool, annotationImage, image, onAnnotationCandidate, preview, working]);

  function updateAnnotation(event: ReactPointerEvent<HTMLDivElement>): void {
    if (annotationStart === undefined) return;
    const end = point(event);
    setAnnotationRect(normalizedAnnotationRect(annotationStart, end));
  }

  function authorCandidate(
    location: PreviewPoint,
    rect?: PreviewAnnotationRect,
    points?: readonly PreviewPoint[],
  ): void {
    if (annotationImage === undefined || onAnnotationCandidate === undefined || builtRequest === undefined) return;
    const binary = atob(annotationImage.data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const evidence = new Blob([bytes], { type: annotationImage.mimeType });
    const thumbnailUrl = URL.createObjectURL(evidence);
    try {
      onAnnotationCandidate({
        mode: rect === undefined ? 'point' : 'region',
        point: location,
        ...(rect === undefined ? {} : { rect }),
        ...(points === undefined ? {} : { stroke: points.map((point) => ({ ...point })) }),
        preview: {
          version: 1,
          provider: 'style-system',
          projectPath: builtRequest.appPath,
          storyPath: annotationImage.storyPath,
          storyExport: annotationImage.storyExport,
          buildRevision: annotationImage.sourceSha256,
          viewport: { width: annotationImage.width, height: annotationImage.height },
          sources: [{ path: annotationImage.storyPath, sha256: annotationImage.sourceSha256 }],
        },
        evidence,
        thumbnailUrl,
      });
    } catch (reason) {
      URL.revokeObjectURL(thumbnailUrl);
      setStatus(errorText(reason));
    }
  }

  const multipleExports = storyExports !== undefined && storyExports.length > 1;
  const previewVisible = preview !== undefined;
  const authorAnnotationActive = onAnnotationCandidate !== undefined && activeTool !== 'select';
  useEffect(() => {
    setStroke([]);
    setAnnotationStart(undefined);
    pointers.current.clear();
    pinch.current = undefined;
    pan.current = undefined;
  }, [activeTool, annotationImage?.sourceSha256]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 p-3" data-testid="style-system-preview-panel">
      {contextual ? (
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-doom-dim">
          <span>
            Story: <strong className="text-doom-text">{storyPath || sourcePath}</strong>
          </span>
          <span>
            Project: <strong className="text-doom-text">{appPath || 'resolving…'}</strong>
          </span>
          {multipleExports ? (
            <label className="flex items-center gap-1">
              Export
              <select
                className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
                value={storyExport}
                aria-label="story export"
                onChange={(event) => {
                  setStoryExport(event.target.value);
                  builtRequestRef.current = undefined;
                  setBuiltRequest(undefined);
                  setAnnotationImage(undefined);
                  setAnnotationRect(undefined);
                }}
              >
                {storyExports.map((entry) => (
                  <option key={entry.exportName} value={entry.exportName}>
                    {entry.label ?? entry.exportName}
                  </option>
                ))}
              </select>
            </label>
          ) : storyExport !== '' ? (
            <span>
              Export: <strong className="text-doom-text">{storyExport}</strong>
            </span>
          ) : null}
        </header>
      ) : (
        <header className="grid gap-2 md:grid-cols-3">
          <label className="grid gap-1 text-xs text-doom-dim">
            Project path
            <input
              className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
              value={appPath}
              onChange={(event) => setAppPath(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-doom-dim">
            Story file
            <input
              className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
              placeholder="packages/ui/Button.stories.tsx"
              value={storyPath}
              onChange={(event) => {
                setStoryPath(event.target.value);
                setStoryExports(undefined);
              }}
            />
          </label>
          <label className="grid gap-1 text-xs text-doom-dim">
            Story export
            {storyExports === undefined ? (
              <input
                className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
                value={storyExport}
                onChange={(event) => setStoryExport(event.target.value)}
              />
            ) : (
              <select
                className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
                value={storyExport}
                onChange={(event) => setStoryExport(event.target.value)}
              >
                <option value="">Choose an export</option>
                {storyExports.map((entry) => (
                  <option key={entry.exportName} value={entry.exportName}>
                    {entry.label ?? entry.exportName}
                  </option>
                ))}
              </select>
            )}
          </label>
        </header>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={
            sessionId === null ||
            working ||
            sourceDirty ||
            request.storyPath.trim() === '' ||
            request.storyExport.trim() === ''
          }
          onClick={() => void rebuild()}
        >
          {previewVisible ? 'Refresh preview' : 'Build preview'}
        </Button>
        <Button
          variant="outline"
          disabled={preview === undefined || working}
          onClick={() => void image().then((result) => result && imageDownload(result.data, result.storyExport))}
        >
          Export PNG
        </Button>
        {onAnnotationCandidate === undefined ? (
          <Button
            variant="outline"
            disabled={preview === undefined || working}
            onClick={() => void prepareAnnotation()}
          >
            Prepare annotation
          </Button>
        ) : null}
        <label className="flex items-center gap-1 text-xs text-doom-dim">
          <input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /> Dark mode
        </label>
        <output className="text-xs text-doom-dim" aria-live="polite">
          {status}
        </output>
      </div>
      {sourceDirty ? (
        <p data-testid="style-system-preview-dirty" className="text-xs text-doom-yellow">
          Save changes to preview. Preview uses saved source.
        </p>
      ) : null}
      {preview === undefined ? (
        <div className="grid min-h-48 place-items-center rounded border border-dashed border-doom-border text-sm text-doom-faint">
          No preview built.
        </div>
      ) : authorAnnotationActive && annotationImage !== undefined ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-doom-border bg-doom-deep">
          <div className="flex items-center gap-2 p-2" role="group" aria-label="Preview zoom">
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              aria-label="Zoom out"
              onClick={() => setZoom((value) => Math.max(1, value / 1.5))}
            >
              −
            </Button>
            <output className="text-xs text-doom-dim">{Math.round(zoom * 100)}%</output>
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              aria-label="Zoom in"
              onClick={() => setZoom((value) => Math.min(8, value * 1.5))}
            >
              +
            </Button>
            <Button variant="outline" className="min-h-11" aria-label="Fit preview" onClick={() => setZoom(1)}>
              Fit
            </Button>
          </div>
          <div ref={imageScroll} className="min-h-0 flex-1 overflow-auto">
            <div
              className="relative w-fit max-w-full overflow-hidden"
              style={{ zoom, touchAction: 'none' }}
              aria-label={
                activeTool === 'comment'
                  ? 'Click to place an annotation point'
                  : activeTool === 'draw'
                    ? 'Draw a feedback location mark'
                    : activeTool === 'pan'
                      ? 'Drag to pan preview'
                      : 'Drag to mark an annotation region'
              }
              data-testid="style-system-author-annotation-overlay"
              onPointerDown={(event) => {
                if (pendingCandidate) return;
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                event.currentTarget.setPointerCapture(event.pointerId);
                if (pointers.current.size === 2) {
                  setStroke([]);
                  setAnnotationStart(undefined);
                  const [a, b] = [...pointers.current.values()];
                  pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom };
                  return;
                }
                if (activeTool === 'pan') {
                  const container = imageScroll.current;
                  if (container)
                    pan.current = {
                      x: event.clientX,
                      y: event.clientY,
                      left: container.scrollLeft,
                      top: container.scrollTop,
                    };
                  return;
                }
                if (activeTool !== 'mark' && activeTool !== 'comment' && activeTool !== 'draw') return;
                setGesture(event.pointerId);
                if (activeTool === 'draw') setStroke([point(event)]);
                const start = point(event);
                setAnnotationStart(start);
                setAnnotationRect(activeTool === 'mark' ? { ...start, width: 0, height: 0 } : undefined);
              }}
              onPointerMove={(event) => {
                if (pointers.current.has(event.pointerId))
                  pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pinch.current !== undefined && pointers.current.size >= 2) {
                  const [a, b] = [...pointers.current.values()];
                  if (pinch.current.distance > 0)
                    setZoom(
                      Math.max(
                        1,
                        Math.min(
                          8,
                          (pinch.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.distance,
                        ),
                      ),
                    );
                  return;
                }
                if (pan.current !== undefined && activeTool === 'pan') {
                  const container = imageScroll.current;
                  if (container) {
                    container.scrollLeft = pan.current.left + pan.current.x - event.clientX;
                    container.scrollTop = pan.current.top + pan.current.y - event.clientY;
                  }
                  return;
                }
                if (gesture !== event.pointerId) return;
                if (activeTool === 'mark') updateAnnotation(event);
                if (activeTool === 'draw')
                  setStroke((points) => (points.length >= 128 ? points : [...points, point(event)]));
              }}
              onPointerUp={(event) => {
                pointers.current.delete(event.pointerId);
                if (pinch.current !== undefined || pan.current !== undefined) {
                  if (pointers.current.size < 2) pinch.current = undefined;
                  pan.current = undefined;
                  return;
                }
                const start = annotationStart;
                if (start === undefined || gesture !== event.pointerId) return;
                if (activeTool === 'draw') {
                  const points = stroke.length >= 128 ? stroke : [...stroke, point(event)];
                  setStroke([]);
                  setAnnotationStart(undefined);
                  if (points.length < 2 || !points.some((item) => item.x !== points[0]?.x || item.y !== points[0]?.y))
                    return;
                  const x = Math.min(...points.map((item) => item.x));
                  const y = Math.min(...points.map((item) => item.y));
                  const rect = {
                    x: Math.min(x, 0.999),
                    y: Math.min(y, 0.999),
                    width: Math.max(0.001, Math.max(...points.map((item) => item.x)) - x),
                    height: Math.max(0.001, Math.max(...points.map((item) => item.y)) - y),
                  };
                  authorCandidate(points[0]!, rect, points);
                  return;
                }
                const end = point(event);
                setAnnotationStart(undefined);
                const location = previewAnnotationLocation(activeTool === 'comment' ? 'comment' : 'mark', start, end);
                if (location === null) return;
                setAnnotationRect(location.mode === 'region' ? location.rect : undefined);
                authorCandidate(location.point, location.mode === 'region' ? location.rect : undefined);
              }}
              onPointerCancel={() => {
                setAnnotationStart(undefined);
                setAnnotationRect(undefined);
                setStroke([]);
                pointers.current.clear();
                pinch.current = undefined;
                pan.current = undefined;
              }}
            >
              <img
                className="block max-h-full max-w-full select-none"
                src={`data:${annotationImage.mimeType};base64,${annotationImage.data}`}
                alt="Frozen source-backed story render for Author annotation"
                draggable={false}
              />
              {displayedAnnotations.map((annotation) =>
                annotation.stroke !== undefined ? (
                  <div
                    key={annotation.ordinal}
                    data-author-stroke={annotation.ordinal}
                    className="pointer-events-none absolute inset-0"
                  >
                    <svg
                      aria-hidden="true"
                      className="absolute inset-0 h-full w-full text-doom-yellow"
                      viewBox="0 0 1000 1000"
                      preserveAspectRatio="none"
                    >
                      <polyline
                        points={annotation.stroke
                          .map((point) => `${String(point.x * 1000)},${String(point.y * 1000)}`)
                          .join(' ')}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span
                      className="absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-doom-yellow px-1 text-2xs font-bold text-doom-deep"
                      style={{
                        left: `${String(annotation.stroke[0]!.x * 100)}%`,
                        top: `${String(annotation.stroke[0]!.y * 100)}%`,
                      }}
                    >
                      {annotation.ordinal}
                    </span>
                  </div>
                ) : annotation.mode === 'point' || annotation.rect === undefined ? (
                  <span
                    key={annotation.ordinal}
                    data-author-point={annotation.ordinal}
                    className="pointer-events-none absolute z-10 flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-doom-deep bg-doom-yellow px-1 text-2xs font-bold text-doom-deep"
                    style={{
                      left: `${String(annotation.point.x * 100)}%`,
                      top: `${String(annotation.point.y * 100)}%`,
                    }}
                  >
                    {annotation.ordinal}
                  </span>
                ) : (
                  <div
                    key={annotation.ordinal}
                    data-author-region={annotation.ordinal}
                    className="pointer-events-none absolute border border-doom-yellow bg-doom-yellow/10"
                    style={{
                      left: `${String(annotation.rect.x * 100)}%`,
                      top: `${String(annotation.rect.y * 100)}%`,
                      width: `${String(annotation.rect.width * 100)}%`,
                      height: `${String(annotation.rect.height * 100)}%`,
                    }}
                  >
                    <span className="bg-doom-yellow text-doom-deep">{annotation.ordinal}</span>
                  </div>
                ),
              )}
              {stroke.length < 2 ? null : (
                <svg
                  aria-hidden="true"
                  data-testid="style-system-author-stroke-selection"
                  className="pointer-events-none absolute inset-0 h-full w-full text-doom-red"
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                >
                  <polyline
                    points={stroke.map((point) => `${String(point.x * 1000)},${String(point.y * 1000)}`).join(' ')}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {annotationRect === undefined ? null : (
                <div
                  className="pointer-events-none absolute border-2 border-red-500 bg-red-500/10"
                  style={{
                    left: `${String(annotationRect.x * 100)}%`,
                    top: `${String(annotationRect.y * 100)}%`,
                    width: `${String(annotationRect.width * 100)}%`,
                    height: `${String(annotationRect.height * 100)}%`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <iframe
          key={preview.handle}
          title={`${preview.storyExport} story preview`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={isolatedPreviewHtml(preview.html)}
          className="min-h-0 flex-1 rounded border border-doom-border bg-white"
        />
      )}
      {annotationImage === undefined || onAnnotationCandidate !== undefined ? null : (
        <div className="grid gap-2">
          <div
            className="relative max-h-80 w-fit max-w-full touch-none overflow-hidden rounded border border-doom-border"
            aria-label="Drag to mark an annotation region"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const start = point(event);
              setAnnotationStart(start);
              setAnnotationRect({ ...start, width: 0, height: 0 });
            }}
            onPointerMove={updateAnnotation}
            onPointerUp={(event) => {
              updateAnnotation(event);
              setAnnotationStart(undefined);
            }}
          >
            <img
              className="block max-h-80 max-w-full select-none"
              src={`data:${annotationImage.mimeType};base64,${annotationImage.data}`}
              alt="Fresh source-backed story render for annotation"
              draggable={false}
            />
            {annotationRect === undefined ? null : (
              <div
                className="pointer-events-none absolute border-2 border-red-500 bg-red-500/10"
                style={{
                  left: `${String(annotationRect.x * 100)}%`,
                  top: `${String(annotationRect.y * 100)}%`,
                  width: `${String(annotationRect.width * 100)}%`,
                  height: `${String(annotationRect.height * 100)}%`,
                }}
              />
            )}
          </div>
          <p className="text-xs text-doom-faint">
            This image is rebuilt from source and does not preserve transient iframe interactions.
          </p>
        </div>
      )}
      {preview === undefined || onAnnotationCandidate !== undefined ? null : (
        <div className="flex gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-xs text-doom-dim">
            AI design feedback
            <textarea
              className="min-h-20 rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
          </label>
          <Button
            className="self-end"
            variant="outline"
            disabled={working || submitCapture === undefined || feedback.trim() === '' || annotationImage === undefined}
            onClick={() => {
              if (submitCapture === undefined || annotationImage === undefined) return;
              const location =
                annotationRect === undefined
                  ? 'Whole preview'
                  : `Region: x=${annotationRect.x.toFixed(3)}, y=${annotationRect.y.toFixed(3)}, width=${annotationRect.width.toFixed(3)}, height=${annotationRect.height.toFixed(3)}`;
              const generation = generationRef.current;
              void submitCapture({
                ...annotationImage,
                context: {
                  kind: 'author-capture',
                  source: 'style-system',
                  id: crypto.randomUUID(),
                  label: `${annotationImage.storyPath}#${annotationImage.storyExport}`,
                  content: [
                    'Edit the underlying story or component source, never the generated preview HTML.',
                    `Project: ${builtRequest?.appPath ?? appPath}`,
                    `Story: ${annotationImage.storyPath}#${annotationImage.storyExport}`,
                    `Story source sha256: ${annotationImage.sourceSha256}`,
                    `Source-backed image revision: ${annotationImage.sourceSha256}`,
                    location,
                    `Feedback: ${feedback.trim()}`,
                    'After editing, rebuild this preview before treating it as visually verified.',
                  ].join('\n'),
                },
              })
                .then(() => {
                  if (generationRef.current !== generation) return;
                  setStatus('Feedback and the frozen source-backed annotation image were submitted to the agent.');
                  setFeedback('');
                })
                .catch((reason: unknown) => {
                  if (generationRef.current === generation) setStatus(errorText(reason));
                });
            }}
          >
            Send to AI
          </Button>
        </div>
      )}
    </section>
  );
}
