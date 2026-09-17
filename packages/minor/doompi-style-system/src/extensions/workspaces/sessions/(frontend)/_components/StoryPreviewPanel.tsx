import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { BuildStoryPreviewRequest, BuildStoryPreviewView } from '../../../../../types/previewApi';
import { buildPreview, disposePreview, exportPreviewImage } from '../_lib/previewApi';
import {
  isolatedPreviewHtml,
  normalizedAnnotationRect,
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
export function StoryPreviewPanel({ sessionId, submitCapture }: WebPluginSlotProps) {
  const [appPath, setAppPath] = useState('.');
  const [storyPath, setStoryPath] = useState('');
  const [storyExport, setStoryExport] = useState('Playground');
  const [darkMode, setDarkMode] = useState(false);
  const [preview, setPreview] = useState<BuildStoryPreviewView>();
  const [builtRequest, setBuiltRequest] = useState<BuildStoryPreviewRequest>();
  const [annotationImage, setAnnotationImage] = useState<{ data: string; mimeType: 'image/png' }>();
  const [annotationStart, setAnnotationStart] = useState<PreviewPoint>();
  const [annotationRect, setAnnotationRect] = useState<PreviewAnnotationRect>();
  const [feedback, setFeedback] = useState('');
  const [status, setStatus] = useState('Choose an exact story file and export.');
  const [working, setWorking] = useState(false);
  const request = useMemo<BuildStoryPreviewRequest>(
    () => ({ appPath, storyPath, storyExport, darkMode }),
    [appPath, storyPath, storyExport, darkMode],
  );

  useEffect(
    () => () => {
      if (sessionId !== null && preview !== undefined) void disposePreview(sessionId, preview.handle);
    },
    [preview, sessionId],
  );

  async function rebuild(): Promise<void> {
    if (sessionId === null || working) return;
    setWorking(true);
    setStatus('Building preview…');
    try {
      const result = await buildPreview(sessionId, request);
      if (!result.ok) {
        setStatus(result.error);
        return;
      }
      setPreview(result.preview);
      setBuiltRequest(request);
      setAnnotationImage(undefined);
      setAnnotationRect(undefined);
      setStatus('Preview ready. Refresh after source edits.');
    } finally {
      setWorking(false);
    }
  }

  async function image(): Promise<{ data: string; mimeType: 'image/png' } | undefined> {
    if (sessionId === null || working || builtRequest === undefined) return undefined;
    setWorking(true);
    setStatus('Rendering a fresh source-backed image…');
    try {
      const result = await exportPreviewImage(sessionId, builtRequest);
      if (!result.ok) {
        setStatus(result.error);
        return undefined;
      }
      setStatus('Image rendered from the current source. Transient iframe interactions are not included.');
      return result.image;
    } finally {
      setWorking(false);
    }
  }

  async function prepareAnnotation(): Promise<void> {
    const result = await image();
    if (result === undefined) return;
    setAnnotationImage(result);
    setAnnotationRect(undefined);
    setStatus('Annotation image ready. Drag a region or comment on the whole preview.');
  }

  function updateAnnotation(event: ReactPointerEvent<HTMLDivElement>): void {
    if (annotationStart === undefined) return;
    const end = point(event);
    setAnnotationRect(normalizedAnnotationRect(annotationStart, end));
  }
  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3" data-testid="style-system-preview-panel">
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
            onChange={(event) => setStoryPath(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-doom-dim">
          Story export
          <input
            className="rounded border border-doom-border bg-doom-bg px-2 py-1 text-doom-text"
            value={storyExport}
            onChange={(event) => setStoryExport(event.target.value)}
          />
        </label>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={sessionId === null || working || storyPath.trim() === ''} onClick={() => void rebuild()}>
          {preview === undefined ? 'Build preview' : 'Refresh preview'}
        </Button>
        <Button
          variant="outline"
          disabled={preview === undefined || working}
          onClick={() => void image().then((result) => result && imageDownload(result.data, storyExport))}
        >
          Export PNG
        </Button>
        <Button variant="outline" disabled={preview === undefined || working} onClick={() => void prepareAnnotation()}>
          Prepare annotation
        </Button>
        <label className="flex items-center gap-1 text-xs text-doom-dim">
          <input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /> Dark mode
        </label>
        <output className="text-xs text-doom-dim" aria-live="polite">
          {status}
        </output>
      </div>
      {preview === undefined ? (
        <div className="grid min-h-48 place-items-center rounded border border-dashed border-doom-border text-sm text-doom-faint">
          No preview built.
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
      {annotationImage === undefined ? null : (
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
      {preview === undefined ? null : (
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
              void submitCapture({
                ...annotationImage,
                context: {
                  kind: 'author-capture',
                  source: 'style-system',
                  id: crypto.randomUUID(),
                  label: `${preview.storyPath}#${preview.storyExport}`,
                  content: [
                    'Edit the underlying story or component source, never the generated preview HTML.',
                    `Project: ${builtRequest?.appPath ?? appPath}`,
                    `Story: ${preview.storyPath}#${preview.storyExport}`,
                    `Story source sha256: ${preview.sourceSha256}`,
                    `Preview artifact revision: ${preview.handle}`,
                    location,
                    `Feedback: ${feedback.trim()}`,
                    'After editing, rebuild this preview before treating it as visually verified.',
                  ].join('\n'),
                },
              }).then(() => {
                setStatus('Feedback and the frozen source-backed annotation image were submitted to the agent.');
                setFeedback('');
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
