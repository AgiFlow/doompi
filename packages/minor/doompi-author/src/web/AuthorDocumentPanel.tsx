import { Button } from '@agimon-ai/doompi-web-components';
import { AuthorGridOverlay, autonomousVoiceGridVisible } from './AuthorGridOverlay.tsx';
import { AuthorMediaView } from './AuthorMediaView.tsx';
import { AuthorTextView } from './AuthorTextView.tsx';
import type { FileLinkSource, TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { focusAuthorViewport } from './authorBrowserBridge.ts';
import { loadAuthorDocument, saveAuthorDocument } from './authorFiles.ts';
import { authorProfilesForDocument } from './authorProfiles.ts';
import type { AuthorDisplayedRegion } from './authorViewportTypes.ts';
import {
  authorDocumentKey,
  authorWorkspace,
  completeAuthorSave,
  failAuthorSave,
  focusAuthorDocument,
  normalizeAuthorPath,
  putAuthorDocument,
  releaseAuthorDocumentFocus,
  requestAuthorSave,
  syncAuthorDocumentFocus,
  type AuthorSessionWorkspace,
} from './authorWorkspaceStore.ts';
import { AuthorStructuredView } from './AuthorStructuredView.tsx';
interface AuthorDocumentPanelProps extends WebPluginSlotProps {
  path: string;
}

function tabId(path: string): string {
  let hash = 2166136261;
  for (const char of normalizeAuthorPath(path)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `author-file-${(hash >>> 0).toString(36)}`;
}

export function displayedAuthorRegions(
  workspace: AuthorSessionWorkspace | undefined,
): readonly AuthorDisplayedRegion[] {
  const draftRegions = workspace?.regions ?? [];
  if (draftRegions.length > 0) return draftRegions.map((region, index) => ({ ordinal: index + 1, region }));
  const activeRequest = workspace?.requests.findLast(
    (request) => request.status === 'REQUESTED' || request.status === 'CHANGING',
  );
  return (activeRequest?.pendingRegions ?? []).map((region) => ({
    ordinal: Math.max(1, (activeRequest?.regions.findIndex((original) => original.id === region.id) ?? 0) + 1),
    region,
  }));
}
export function AuthorDocumentPanel(props: AuthorDocumentPanelProps) {
  if (!props.activeMinorModes?.includes('author')) {
    return (
      <p data-testid="author-mode-inactive" className="p-4 text-[11px] text-doom-dim">
        Enable Author minor mode to edit this document.
      </p>
    );
  }
  return <ActiveAuthorDocumentPanel {...props} />;
}

function ActiveAuthorDocumentPanel({ path, sessionId, statuses }: AuthorDocumentPanelProps) {
  const document = useStore(authorWorkspace.store, (state) =>
    sessionId === null ? undefined : state.documents[authorDocumentKey(sessionId, path)],
  );
  const focusGeneration = useRef<number | undefined>(undefined);
  const workspace = useStore(authorWorkspace.store, (state) =>
    sessionId === null ? undefined : state.sessions[sessionId],
  );
  const activeTool = workspace?.activeTool ?? 'select';
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [status, setStatus] = useState<string | undefined>();
  const kind = document?.kind;
  useEffect(() => {
    if (document !== undefined || sessionId === null) return;
    const controller = new AbortController();
    setStatus('loading');
    void loadAuthorDocument(sessionId, path, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        putAuthorDocument(sessionId, loaded);
        setStatus(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [document, path, sessionId]);
  useEffect(() => {
    if (document === undefined || sessionId === null) return;
    const generation = focusAuthorDocument(sessionId, path, document.version, document.sourceSha256);
    focusGeneration.current = generation;
    return () => releaseAuthorDocumentFocus(sessionId, generation);
  }, [kind, document?.sourceSha256, path, sessionId]);
  useEffect(() => {
    const generation = focusGeneration.current;
    if (document === undefined || sessionId === null || generation === undefined) return;
    syncAuthorDocumentFocus(sessionId, generation, document.version, document.sourceSha256);
  }, [document?.sourceSha256, document?.version, sessionId]);
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
      failAuthorSave(sessionId, path, savedVersion);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const gridVisible = autonomousVoiceGridVisible(statuses);
  const displayedRegions = displayedAuthorRegions(workspace);
  const textPanel = (
    <AuthorTextView
      sessionId={sessionId}
      document={document}
      preview={document.kind === 'markdown' && markdownPreview && activeTool === 'select' && !gridVisible}
      displayedRegions={displayedRegions}
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
          disabled={document.revisions.length === 0 || document.savingVersion !== undefined}
          onClick={() => void save()}
        >
          Save
        </Button>
      </header>
      {status === undefined ? null : <output className="px-4 py-1 text-[10px] text-doom-faint">{status}</output>}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {document.kind === 'text' || document.kind === 'markdown' ? (
          textPanel
        ) : document.structuredFormat !== undefined ? (
          <AuthorStructuredView sessionId={sessionId} document={document} displayedRegions={displayedRegions} />
        ) : (
          <AuthorMediaView
            key={document.path}
            sessionId={sessionId}
            document={document}
            activeTool={activeTool}
            displayedRegions={displayedRegions}
          />
        )}
        <AuthorGridOverlay sessionId={sessionId} document={document} visible={gridVisible} />
      </div>
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
