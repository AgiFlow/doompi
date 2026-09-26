import type { FileLinkSource, TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';

import { api } from '../../../../../../generated/client';
import {
  authorPreviewActionSlot,
  type AuthorPreviewActionSource,
  type AuthorPreviewDisplayedAnnotation,
} from '../../../../../types/authorPreview';
import { dropAuthorViewportSession, focusAuthorViewport, openAuthorCanvas } from '../_lib/authorBrowserBridge';
import { canvasAliases, canvasFailures, canvasPaths } from '../_lib/authorCanvasState';
import { loadAuthorDocument, saveAuthorDocument } from '../_lib/authorFiles';
import { authorProfilesForDocument } from '../_lib/authorProfiles';
import type { AuthorDisplayedRegion } from '../_lib/authorViewportTypes';
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
  setAuthorRegionCandidate,
  setAuthorStoryPreview,
  setAuthorToolMode,
  syncAuthorDocumentFocus,
  type AuthorSessionWorkspace,
} from '../_lib/authorWorkspaceStore';
import { AuthorFeedbackControls } from '../dock/_components/AuthorFeedbackControls';
import { AuthorGridOverlay, autonomousVoiceGridVisible } from './AuthorGridOverlay';
import { AuthorMediaView } from './AuthorMediaView';
import { AuthorStructuredView } from './AuthorStructuredView';
import { AuthorTextView } from './AuthorTextView';
interface AuthorDocumentPanelProps extends WebPluginSlotProps {
  path: string;
  alias?: string;
}

const pendingCanvases = new Map<string, AbortController>();
const canvasOwners = new Map<string, Set<string>>();

function tabId(path: string): string {
  let hash = 2166136261;
  for (const char of normalizeAuthorPath(path)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `author-file-${(hash >>> 0).toString(36)}`;
}

export function displayedAuthorRegions(
  workspace: Pick<AuthorSessionWorkspace, 'regions' | 'requests'> | undefined,
): readonly AuthorDisplayedRegion[] {
  const draftRegions = workspace?.regions ?? [];
  if (draftRegions.length > 0) return draftRegions.map((region, index) => ({ ordinal: index + 1, region }));
  const activeRequest = workspace?.requests
    .slice()
    .reverse()
    .find((request) => request.status === 'REQUESTED' || request.status === 'CHANGING');
  return (activeRequest?.pendingRegions ?? []).map((region) => ({
    ordinal: Math.max(1, (activeRequest?.regions.findIndex((original) => original.id === region.id) ?? 0) + 1),
    region,
  }));
}
export function AuthorDocumentPanel(props: AuthorDocumentPanelProps) {
  if (!props.activeMinorModes?.includes('author')) {
    const fallback = props.fileTabFor(props.path);
    if (fallback !== undefined && fallback.id !== tabId(props.path)) {
      return <fallback.panel {...props} />;
    }
    return (
      <p data-testid="author-mode-inactive" className="p-3 text-sm text-doom-dim">
        No file viewer is available for this path.
      </p>
    );
  }
  return <ActiveAuthorDocumentPanel {...props} />;
}

function ActiveAuthorDocumentPanel(props: AuthorDocumentPanelProps) {
  const { sessionId, statuses } = props;
  const path = useStore(canvasPaths, (state) =>
    sessionId === null ? props.path : (state[authorDocumentKey(sessionId, props.path)] ?? props.path),
  );
  const alias = useStore(
    canvasAliases,
    (state) => props.alias ?? (sessionId === null ? undefined : state[authorDocumentKey(sessionId, props.path)]),
  );
  const loadFailure = useStore(canvasFailures, (state) =>
    sessionId === null ? undefined : state[authorDocumentKey(sessionId, props.path)],
  );
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const kind = document?.kind;
  const previewSource: AuthorPreviewActionSource | undefined =
    document === undefined
      ? undefined
      : {
          path: document.path,
          kind: document.kind,
          hasUnsavedChanges: document.version !== document.savedVersion,
          revision: document.savedVersion,
          sourceSha256: document.sourceSha256,
        };
  const previewAction =
    previewSource === undefined
      ? undefined
      : (props.slotData?.(authorPreviewActionSlot) ?? []).find(
          ({ data }) =>
            data.embeddedPanel !== undefined &&
            (data.supportsSource === undefined || data.supportsSource(previewSource)),
        );
  const PreviewPanel = previewAction?.data.embeddedPanel;
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
    if (kind === undefined || sessionId === null || alias === undefined) return;
    const profiles = authorProfilesForDocument(sessionId, path, kind);
    let release: (() => void) | undefined;
    let cancelled = false;
    void focusAuthorViewport(sessionId, profiles, alias).then((nextRelease) => {
      if (cancelled) nextRelease();
      else release = nextRelease;
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [alias, kind, path, sessionId]);
  if (document === undefined || sessionId === null) {
    return <p className="p-4 text-sm text-doom-faint">{loadFailure ?? status ?? 'Loading document...'}</p>;
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
  const displayedPreviewAnnotations: readonly AuthorPreviewDisplayedAnnotation[] =
    displayedRegions.flatMap<AuthorPreviewDisplayedAnnotation>(({ ordinal, region }) => {
      if (region.anchor.kind === 'story-preview-rect') {
        return [
          {
            ordinal,
            mode: 'region' as const,
            point: region.anchor.rect,
            rect: region.anchor.rect,
            stroke: region.stroke,
          },
        ];
      }
      if (region.anchor.kind === 'story-preview-point') {
        return [{ ordinal, mode: 'point' as const, point: region.anchor.point }];
      }
      return [];
    });
  const textPanel = (
    <AuthorTextView
      sessionId={sessionId}
      document={document}
      preview={document.kind === 'markdown' && markdownPreview && activeTool === 'select' && !gridVisible}
      displayedRegions={displayedRegions}
    />
  );
  const sourcePanel =
    document.kind === 'text' || document.kind === 'markdown' || document.kind === 'story-preview' ? (
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
        pendingCandidate={workspace?.candidate !== undefined}
        seekRequest={workspace?.videoSeekRequest}
      />
    );

  return (
    <section data-testid="author-document" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-doom-border px-4 py-2">
        <strong className="min-w-0 flex-1 truncate text-base text-doom-hi">
          {alias === undefined ? '' : `${alias} · `}
          {document.title ?? document.path}
        </strong>
        {PreviewPanel !== undefined && previewSource !== undefined ? (
          <Button
            size="xs"
            variant={previewOpen ? 'primary' : 'outline'}
            data-testid="author-story-preview-toggle"
            aria-pressed={previewOpen}
            aria-label={previewOpen ? 'show story source' : 'show story preview'}
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            {previewOpen ? 'Source' : 'Preview'}
          </Button>
        ) : null}
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
        {document.kind === 'video' ? (
          <span className="text-base text-doom-dim">Video feedback</span>
        ) : (
          <Button
            className="min-h-11 px-4 text-base"
            variant="outline"
            data-testid="author-save"
            disabled={document.revisions.length === 0 || document.savingVersion !== undefined}
            onClick={() => void save()}
          >
            {previewOpen && previewSource?.hasUnsavedChanges ? 'Save & refresh' : 'Save'}
          </Button>
        )}
      </header>
      {status === undefined ? null : <output className="px-4 py-1 text-xs text-doom-faint">{status}</output>}
      {['image', 'pdf', 'video', 'story-preview'].includes(document.kind) ? (
        <nav
          aria-label="Author canvas tools"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-doom-border px-2 py-1 sm:hidden"
        >
          {(['select', 'pan', 'mark', 'comment', 'draw'] as const).map((mode) => (
            <Button
              key={mode}
              size="xs"
              variant={activeTool === mode ? 'primary' : 'outline'}
              className="min-h-11 min-w-11 shrink-0"
              aria-label={`${mode} tool`}
              aria-pressed={activeTool === mode}
              onClick={() => setAuthorToolMode(sessionId, mode)}
            >
              {mode}
            </Button>
          ))}
        </nav>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {previewOpen && PreviewPanel !== undefined && previewSource !== undefined ? (
          <PreviewPanel
            {...props}
            source={previewSource}
            activeTool={activeTool === 'crop' ? 'select' : activeTool}
            displayedAnnotations={displayedPreviewAnnotations}
            pendingCandidate={workspace?.candidate !== undefined}
            onAnnotationCandidate={(candidate) => {
              setAuthorStoryPreview(sessionId, document.path, candidate.preview);
              setAuthorRegionCandidate(sessionId, {
                documentPath: document.path,
                revision: document.version,
                sourceSha256: document.sourceSha256,
                mode: candidate.mode,
                stroke: candidate.stroke,
                anchor:
                  candidate.mode === 'region' && candidate.rect !== undefined
                    ? { kind: 'story-preview-rect', rect: candidate.rect, preview: candidate.preview }
                    : { kind: 'story-preview-point', point: candidate.point, preview: candidate.preview },
                viewport: candidate.preview.viewport,
                evidence: candidate.evidence,
                thumbnailUrl: candidate.thumbnailUrl,
                createdAt: Date.now(),
              });
            }}
          />
        ) : (
          sourcePanel
        )}
        {previewOpen && PreviewPanel !== undefined && previewSource !== undefined ? null : (
          <AuthorGridOverlay sessionId={sessionId} document={document} visible={gridVisible} />
        )}
      </div>
      {workspace !== undefined && ['image', 'pdf', 'video', 'story-preview'].includes(document.kind) ? (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-doom-border p-2 sm:hidden">
          <AuthorFeedbackControls
            sessionId={sessionId}
            document={document}
            workspace={workspace}
            submitCapture={props.submitCapture}
          />
        </div>
      ) : null}
    </section>
  );
}

export function authorFileTab(path: string, preferredAlias?: string): TransientTab {
  const normalized = normalizeAuthorPath(path);
  return {
    id: tabId(normalized),
    label:
      preferredAlias === undefined
        ? (normalized.split('/').at(-1) ?? normalized)
        : `${preferredAlias} · ${normalized.split('/').at(-1) ?? normalized}`,
    retainComposer: true,
    onOpen(sessionId) {
      const key = authorDocumentKey(sessionId, normalized);
      const controller = new AbortController();
      pendingCanvases.set(key, controller);
      canvasFailures.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
      void (async () => {
        const result = await api.session(sessionId).documentsOpen({
          body: { path: normalized, ...(preferredAlias === undefined ? {} : { alias: preferredAlias }) },
          query: { session: sessionId },
          signal: controller.signal,
        });
        if (!result.ok) throw new Error(result.error);
        if (!('alias' in result.data) || typeof result.data.alias !== 'string')
          throw new Error('The Author canvas did not return an alias. Reopen the document.');
        const opened = result.data;
        const canonicalAlias = opened.alias!;
        if (controller.signal.aborted || pendingCanvases.get(key) !== controller) {
          if ((canvasOwners.get(`${sessionId}\n${canonicalAlias}`)?.size ?? 0) === 0)
            void api
              .session(sessionId)
              .bridgeClose({ body: { alias: canonicalAlias } })
              .catch(() => undefined);
          return;
        }
        canvasAliases.setState((state) => ({
          ...state,
          [key]: canonicalAlias,
          [authorDocumentKey(sessionId, opened.path)]: canonicalAlias,
        }));
        canvasPaths.setState((state) => ({ ...state, [key]: opened.path }));
        const ownerKey = `${sessionId}\n${canonicalAlias}`;
        const owners = canvasOwners.get(ownerKey) ?? new Set<string>();
        owners.add(key);
        canvasOwners.set(ownerKey, owners);
        const documentKey = authorDocumentKey(sessionId, opened.path);
        if (authorWorkspace.store.state.documents[documentKey] === undefined) {
          const loaded = await loadAuthorDocument(sessionId, opened.path, controller.signal);
          if (controller.signal.aborted || pendingCanvases.get(key) !== controller) return;
          putAuthorDocument(sessionId, loaded);
        }
        const document = authorWorkspace.store.state.documents[documentKey];
        if (document !== undefined && !controller.signal.aborted)
          await openAuthorCanvas(
            sessionId,
            canonicalAlias,
            authorProfilesForDocument(sessionId, opened.path, document.kind),
          );
      })()
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            canvasFailures.setState((state) => ({
              ...state,
              [key]: error instanceof Error ? error.message : String(error),
            }));
        })
        .finally(() => {
          if (pendingCanvases.get(key) === controller) pendingCanvases.delete(key);
        });
    },
    onClose(sessionId) {
      const key = authorDocumentKey(sessionId, normalized);
      pendingCanvases.get(key)?.abort();
      pendingCanvases.delete(key);
      const alias = canvasAliases.state[key] ?? preferredAlias;
      if (alias === undefined) {
        // Opening may have reached the server before the browser aborted its response.
        void api
          .session(sessionId)
          .documentsOpen({ body: { path: normalized }, query: { session: sessionId } })
          .then((result) => {
            if (!result.ok || !('alias' in result.data) || typeof result.data.alias !== 'string') return;
            const recoveredAlias = result.data.alias;
            if ((canvasOwners.get(`${sessionId}\n${recoveredAlias}`)?.size ?? 0) === 0)
              void api
                .session(sessionId)
                .bridgeClose({ body: { alias: recoveredAlias } })
                .catch(() => undefined);
          })
          .catch(() => undefined);
        return;
      }
      const owners = canvasOwners.get(`${sessionId}\n${alias}`);
      owners?.delete(key);
      if (owners !== undefined && owners.size === 0) canvasOwners.delete(`${sessionId}\n${alias}`);
      const lastOwner = owners === undefined || owners.size === 0;
      if (lastOwner) dropAuthorViewportSession(sessionId, alias);
      canvasAliases.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
      canvasPaths.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
      canvasFailures.setState((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
      if (lastOwner)
        void api
          .session(sessionId)
          .bridgeClose({ body: { alias } })
          .catch(() => undefined);
    },
    panel: (props) => <AuthorDocumentPanel {...props} path={normalized} />,
  };
}

export const authorFileLinks: FileLinkSource = {
  requiredMinorMode: 'author',
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
      : authorFileTab(normalized, canvasAliases.state[authorDocumentKey(sessionId, normalized)]);
  },
  openPath(sessionId, path) {
    if (sessionId === null) return undefined;
    const normalized = normalizeAuthorPath(path);
    return normalized === ''
      ? undefined
      : authorFileTab(normalized, canvasAliases.state[authorDocumentKey(sessionId, normalized)]);
  },
};
