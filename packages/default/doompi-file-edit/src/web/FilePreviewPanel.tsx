import { Breadcrumb, Button, CodeEditor, Markdown, MediaPreview } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useState } from 'react';
import type { FileEditsPreviewView } from '../types/fileEditsApi.ts';
import { fetchFilePreview, sessionFileUrl } from './filesApi.ts';
import { fileTabId, previewModeOf } from './fileView.ts';

/**
 * A file the session never changed, opened read-only.
 *
 * The tab a changed file opens is built around its history: a diff, a version
 * list, an editor, a delete. None of that exists for a file the session only
 * read, and offering an edit view over a file this package holds no baseline
 * for would put a save behind a reader who cannot see what they are about to
 * overwrite. So this is one view, the file as it stands, and nothing else.
 *
 * Its content comes from the preview route, which is bounded by the session's
 * working directory rather than by the timeline.
 */

interface FilePreviewPanelProps extends WebPluginSlotProps {
  filePath: string;
}

/** What one fetch settled on, tagged with the file it was about. */
interface Loaded {
  path: string;
  preview?: FileEditsPreviewView;
  error?: string;
}

export function FilePreviewPanel({ filePath, sessionId, closeTransientTab }: FilePreviewPanelProps) {
  // The answer carries the path it answered for, so switching files is a state
  // that does not match rather than a reset the effect has to perform.
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    void fetchFilePreview(sessionId, filePath).then((result) => {
      if (cancelled) return;
      setLoaded(result.ok ? { path: filePath, preview: result.preview } : { path: filePath, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, filePath]);

  const current = loaded?.path === filePath ? loaded : undefined;
  const preview = current?.preview;
  const error = current?.error;
  // Before the answer arrives the path is all there is to name the file by,
  // and the route's own relative path replaces it once it does.
  const relPath = preview?.relPath ?? filePath;
  const working = preview?.working;
  const content = working?.content ?? '';
  const previewMode = previewModeOf(relPath, working?.unavailable === true);
  const mediaSrc = sessionId === null ? '' : sessionFileUrl(sessionId, relPath);

  return (
    <div data-testid="files-preview-panel" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-doom-border px-4 py-2">
        <Breadcrumb path={relPath} data-testid="files-preview-breadcrumb" className="min-w-0 flex-1" />
        <span className="shrink-0 text-[9px] text-doom-faint">unchanged</span>
        <Button
          variant="ghost"
          size="xs"
          data-testid="files-preview-close"
          onClick={() => closeTransientTab(filePreviewTabId(filePath))}
          className="shrink-0 text-[9px]"
        >
          close
        </Button>
      </header>

      {error === undefined ? null : (
        <p data-testid="files-preview-error" className="px-4 py-3 text-[11px] text-doom-red">
          {error}
        </p>
      )}
      {preview === undefined && error === undefined ? (
        <p data-testid="files-preview-loading" className="px-4 py-3 text-[11px] text-doom-faint">
          reading this file…
        </p>
      ) : null}

      {preview === undefined ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="files-preview"
            data-mode={previewMode}
            className="flex h-full flex-col gap-2 p-4 text-[12px] text-doom-text"
          >
            {previewMode === 'unavailable' ? (
              <p data-testid="files-preview-unavailable" className="text-[11px] text-doom-faint">
                {working?.reason ?? 'this file cannot be shown'}
              </p>
            ) : null}
            {previewMode === 'media' || previewMode === 'unavailable' ? (
              <MediaPreview src={mediaSrc} path={relPath} data-testid="files-preview-media" />
            ) : previewMode === 'markdown' ? (
              <Markdown text={content} />
            ) : previewMode === 'html' ? (
              <iframe
                data-testid="files-preview-html"
                title={relPath}
                sandbox=""
                srcDoc={content}
                className="h-[36rem] w-full rounded border border-doom-border bg-doom-deep"
              />
            ) : previewMode === 'code' ? (
              <CodeEditor
                data-testid="files-preview-code"
                value={content}
                path={relPath}
                readOnly
                className="min-h-[24rem] flex-1 rounded border border-doom-border"
              />
            ) : (
              <pre
                data-testid="files-preview-text"
                className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.5] text-doom-text"
              >
                {content}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The id of the read-only tab, kept apart from the changed-file tab's own id:
 * the same file can be read now and changed later, and the two tabs are not
 * the same view of it.
 */
export function filePreviewTabId(filePath: string): string {
  return `${fileTabId(filePath)}-preview`;
}

/** The transient tab an unchanged file opens in; the same file reopens rather than duplicating. */
export function filePreviewTab(filePath: string): TransientTab {
  return {
    id: filePreviewTabId(filePath),
    label: filePath.split('/').at(-1) ?? filePath,
    panel: (props) => <FilePreviewPanel {...props} filePath={filePath} />,
  };
}
