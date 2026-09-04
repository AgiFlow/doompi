import {
  Button,
  CodeEditor,
  Markdown,
  MediaPreview,
  type EditorSelectionRange,
} from '@agimon-ai/doompi-web-components';
import type { FileLinkSource, TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { focusAuthorViewport } from './authorBrowserBridge.ts';
import { attachAuthorCapture, imageCaptureProvider } from './authorCapture.ts';
import { loadAuthorDocument, saveAuthorDocument } from './authorFiles.ts';
import { authorProfilesForDocument } from './authorProfiles.ts';
import {
  addAuthorAnnotation,
  authorDocumentKey,
  authorWorkspace,
  completeAuthorSave,
  normalizeAuthorPath,
  putAuthorDocument,
  requestAuthorSave,
  reviseAuthorDocument,
  reviseAuthorFragment,
} from './authorWorkspaceStore.ts';

interface AuthorDocumentPanelProps extends WebPluginSlotProps {
  path: string;
}

function tabId(path: string): string {
  let hash = 2166136261;
  for (const char of normalizeAuthorPath(path)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `author-file-${(hash >>> 0).toString(36)}`;
}

export function AuthorDocumentPanel({ path, sessionId, attachComposerCapture }: AuthorDocumentPanelProps) {
  const document = useStore(authorWorkspace.store, (state) =>
    sessionId === null ? undefined : state.documents[authorDocumentKey(sessionId, path)],
  );
  const imageRef = useRef<HTMLImageElement>(null);
  const selection = useRef<EditorSelectionRange | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [status, setStatus] = useState<string | undefined>();
  const kind = document?.kind;
  useEffect(() => {
    if (document !== undefined || sessionId === null) return;
    const controller = new AbortController();
    setStatus('loading');
    void loadAuthorDocument(sessionId, path, controller.signal)
      .then((loaded) => {
        putAuthorDocument(sessionId, loaded);
        setStatus(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [document, path, sessionId]);
  useEffect(() => {
    if (kind === undefined || sessionId === null) return;
    const profiles = authorProfilesForDocument(sessionId, path, kind);
    let release: (() => void) | undefined;
    let cancelled = false;
    void focusAuthorViewport(sessionId, profiles).then((nextRelease) => {
      if (cancelled) nextRelease();
      else release = nextRelease;
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [kind, path, sessionId]);
  if (document === undefined || sessionId === null) {
    return <p className="p-4 text-[11px] text-doom-faint">{status ?? 'Loading document...'}</p>;
  }

  const addComment = (): void => {
    if (comment.trim() === '') return;
    const range = selection.current;
    addAuthorAnnotation(sessionId, path, {
      id: `${Date.now()}:${document.annotations.length}`,
      kind: 'comment',
      body: comment,
      ...(range?.text === undefined || range.text === '' ? {} : { quote: range.text }),
      ...(range === undefined ? {} : { startLine: range.startLine, endLine: range.endLine }),
    });
    setComment('');
  };

  const save = async (): Promise<void> => {
    const savedVersion = document.version;
    const savedFragments = document.fragments;
    requestAuthorSave(sessionId, path);
    setStatus('saving');
    try {
      const sha256 = await saveAuthorDocument(sessionId, document);
      completeAuthorSave(sessionId, path, sha256, savedVersion, savedFragments);
      setStatus('saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const capture = async (): Promise<void> => {
    const image = imageRef.current;
    if (image === null) return;
    await attachAuthorCapture(
      imageCaptureProvider(image, document.crop),
      {
        kind: 'author-viewport',
        source: 'author',
        id: `${sessionId}:${document.path}`,
        label: document.title ?? document.path.split('/').at(-1) ?? document.path,
        content: JSON.stringify({ path: document.path, crop: document.crop, annotations: document.annotations }),
      },
      attachComposerCapture,
    );
  };

  const textPanel =
    document.kind === 'markdown' && markdownPreview ? (
      <div data-testid="author-markdown" className="min-h-0 flex-1 overflow-auto p-4 text-[12px] text-doom-text">
        <Markdown text={document.content ?? ''} />
      </div>
    ) : (
      <CodeEditor
        value={document.content ?? ''}
        path={document.path}
        data-testid="author-editor"
        className="min-h-[24rem] flex-1"
        onChange={(content) => reviseAuthorDocument(sessionId, path, content)}
        onSelect={(range) => {
          selection.current = range;
        }}
      />
    );

  return (
    <section data-testid="author-document" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-doom-border px-4 py-2">
        <strong className="min-w-0 flex-1 truncate text-[11px] text-doom-hi">{document.title ?? document.path}</strong>
        {document.kind === 'markdown' ? (
          <Button
            size="xs"
            variant="ghost"
            data-testid="author-markdown-toggle"
            onClick={() => setMarkdownPreview(!markdownPreview)}
          >
            {markdownPreview ? 'edit' : 'preview'}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          data-testid="author-save"
          disabled={document.revisions.length === 0}
          onClick={() => void save()}
        >
          Save
        </Button>
      </header>
      {status === undefined ? null : <output className="px-4 py-1 text-[10px] text-doom-faint">{status}</output>}
      {document.kind === 'text' || document.kind === 'markdown' ? (
        textPanel
      ) : document.structuredFormat !== undefined ? (
        <div data-testid="author-structured" className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
          {(document.fragments ?? []).map((fragment) => (
            <label key={fragment.id} className="block text-[10px] text-doom-faint">
              {fragment.location}
              <textarea
                value={fragment.text}
                readOnly={fragment.readOnly === true}
                className="mt-1 min-h-16 w-full rounded border border-doom-border bg-doom-deep p-2 text-[11px] text-doom-text"
                onChange={(event) => reviseAuthorFragment(sessionId, path, fragment.id, event.target.value)}
              />
            </label>
          ))}
        </div>
      ) : document.kind === 'image' ? (
        <div className="relative min-h-0 flex-1 overflow-auto p-4">
          <img ref={imageRef} src={document.mediaUrl} alt={document.path} className="max-h-[36rem] max-w-full" />
          {document.crop === undefined ? null : (
            <div
              data-testid="author-crop-overlay"
              className="pointer-events-none absolute border-2 border-doom-green bg-doom-green/10"
              style={{
                left: document.crop.x,
                top: document.crop.y,
                width: document.crop.width,
                height: document.crop.height,
              }}
            />
          )}
          <Button size="xs" variant="outline" data-testid="author-capture" onClick={() => void capture()}>
            attach capture
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-4">
          <MediaPreview
            src={document.mediaUrl ?? ''}
            path={document.path}
            kind={document.kind === 'video' || document.kind === 'pdf' ? document.kind : 'download'}
            data-testid="author-media"
          />
          <span data-testid="author-capture-unavailable" className="text-[10px] text-doom-faint">
            capture unavailable
          </span>
        </div>
      )}
      <footer className="border-t border-doom-border p-3">
        <div className="flex gap-2">
          <input
            value={comment}
            aria-label="Annotation comment"
            className="min-w-0 flex-1 rounded border border-doom-border bg-doom-deep px-2 text-[11px]"
            onChange={(event) => setComment(event.target.value)}
          />
          <Button size="xs" variant="ghost" data-testid="author-add-comment" onClick={addComment}>
            add comment
          </Button>
        </div>
        {document.annotations.map((annotation) => (
          <p key={annotation.id} data-testid="author-annotation" className="mt-1 text-[10px] text-doom-text">
            {annotation.kind}: {annotation.body || `${annotation.startLine}-${annotation.endLine}`}
          </p>
        ))}
      </footer>
    </section>
  );
}

export function authorFileTab(path: string): TransientTab {
  const normalized = normalizeAuthorPath(path);
  return {
    id: tabId(normalized),
    label: normalized.split('/').at(-1) ?? normalized,
    retainComposer: true,
    panel: (props) => <AuthorDocumentPanel {...props} path={normalized} />,
  };
}

export const authorFileLinks: FileLinkSource = {
  subscribe(listener) {
    const subscription = authorWorkspace.store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  fingerprint(sessionId) {
    if (sessionId === null) return '';
    const prefix = `${sessionId}\n`;
    return Object.keys(authorWorkspace.store.state.documents)
      .filter((key) => key.startsWith(prefix))
      .sort()
      .join('\n');
  },
  resolve(sessionId, path) {
    if (sessionId === null) return undefined;
    const normalized = normalizeAuthorPath(path.replace(/:\d+(?::\d+)?$/, ''));
    return authorWorkspace.store.state.documents[authorDocumentKey(sessionId, normalized)] === undefined
      ? undefined
      : authorFileTab(normalized);
  },
  openPath(sessionId, path) {
    if (sessionId === null) return undefined;
    const normalized = normalizeAuthorPath(path);
    return normalized === '' ? undefined : authorFileTab(normalized);
  },
};
