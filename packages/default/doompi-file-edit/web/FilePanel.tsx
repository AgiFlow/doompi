import {
  Badge,
  Breadcrumb,
  Button,
  CodeEditor,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type EditorSelectionRange,
  KebabIcon,
  Markdown,
  MediaPreview,
} from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import type { FileEditsVersionView } from '../src/types/fileEditsApi.ts';
import { CommentDraft } from './CommentDraft.tsx';
import { DeleteFileDialog } from './DeleteFileDialog.tsx';
import { DiffView } from './DiffView.tsx';
import { deleteFile, fetchFileDetail, saveFileContent, sessionFileUrl } from './filesApi.ts';
import { addComment, clearComments, files, markLoading, removeComment, storeDetail, storeError } from './filesStore.ts';
import { buildReviewPrompt, commentAnchor, fileTabId, previewModeOf, TOOL_LABEL } from './fileView.ts';

/**
 * One file's tab: what this session did to it, and what the reader wants done
 * next.
 *
 * Three views over the same file. The diff answers "what changed", the history
 * below it answers "in what order", and edit is where a reader fixes a line
 * themselves rather than asking for it. Preview exists because a changed
 * README is read, not diffed, and because a changed PDF or screenshot has no
 * text to read at all.
 *
 * The tab is transient: it belongs to the session and the page, and closing it
 * is how it ends. Its cached detail lives in the session store, so reopening
 * the same file does not refetch a history the session already answered.
 */

/**
 * `preview` and `diff` are the two ways of reading the file and sit in the
 * header. `edit` is a mode entered from the menu and left by picking either
 * reading view; the draft survives the trip, so leaving to check a diff does
 * not throw away what was typed.
 */
type View = 'preview' | 'diff' | 'edit';

interface FilePanelProps extends WebPluginSlotProps {
  filePath: string;
  relPath: string;
}

interface Draft {
  snippet: string;
  startLine?: number;
  endLine?: number;
}

/** How a version heads its row: what ran, when, and what it moved. */
function versionSummary(version: FileEditsVersionView): string {
  const time = new Date(version.at).toLocaleTimeString();
  const counts = version.hunks === undefined ? '' : ` +${version.additions} -${version.removals}`;
  return `${time} · ${TOOL_LABEL[version.tool] ?? version.tool}${counts}`;
}

export function FilePanel({ filePath, relPath, sessionId, sendSessionFrame, closeTransientTab }: FilePanelProps) {
  const session = useStore(files.store, (state) => files.select(state, sessionId));
  const detail = session.detail[filePath];
  const error = session.errors[filePath];
  const loading = session.loading.includes(filePath);
  const comments = session.comments.filter((comment) => comment.path === filePath);

  // Preview first: clicking a file is a request to look at the file, and the
  // diff is one question about it. The diff is one click away and the counts
  // beside the toggles already say whether there is one worth opening.
  const [view, setView] = useState<View>('preview');
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The editor reports a range on every cursor move, and the comment box takes
  // focus when it opens. Holding the latest range here and raising the box on
  // mouse or key release keeps a drag from stealing focus halfway through it,
  // and a ref rather than state keeps a cursor move from re-rendering the tab.
  const selection = useRef<EditorSelectionRange | undefined>(undefined);

  // One fetch per open, and again whenever the session reports the file moved:
  // the count changing is the cheapest signal that the history grew.
  const revision = session.items.find((item) => item.path === filePath)?.count ?? 0;
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    markLoading(sessionId, filePath);
    void fetchFileDetail(sessionId, filePath).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        storeDetail(sessionId, result.detail);
        setSource(undefined);
        setSaveNote(undefined);
      } else storeError(sessionId, filePath, result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, filePath, revision]);

  const working = detail?.working;
  const content = source ?? working?.content ?? '';
  const previewMode = previewModeOf(relPath, working?.unavailable === true);
  // An image, a video or a PDF is shown rather than read as text, and it is
  // shown from the hub's own bytes route rather than from the detail payload,
  // which carries text only.
  const mediaSrc = sessionId === null ? '' : sessionFileUrl(sessionId, relPath);

  const openDraft = (selection: Draft): void => {
    setDraft(selection);
  };

  /** Raises the comment box on whatever the editor last reported, if that was a selection. */
  const openSelectionDraft = (): void => {
    const range = selection.current;
    if (range === undefined || range.text.trim() === '') return;
    openDraft({ snippet: range.text, startLine: range.startLine, endLine: range.endLine });
  };

  const submitDraft = (body: string): void => {
    if (sessionId === null || draft === undefined) return;
    addComment(sessionId, {
      // The anchor plus the note's position is unique within a file, and a
      // comment never outlives the session that holds it.
      id: `${filePath}:${draft.startLine ?? 0}:${comments.length}:${body.length}`,
      path: filePath,
      relPath,
      ...(draft.startLine === undefined ? {} : { startLine: draft.startLine }),
      ...(draft.endLine === undefined ? {} : { endLine: draft.endLine }),
      snippet: draft.snippet,
      body,
    });
    setDraft(undefined);
  };

  const sendReview = (): void => {
    if (sessionId === null || comments.length === 0) return;
    sendSessionFrame(sessionId, { type: 'prompt', message: buildReviewPrompt(comments) });
    clearComments(sessionId, filePath);
  };

  const confirmDelete = async (): Promise<void> => {
    if (sessionId === null) return;
    setConfirmingDelete(false);
    const result = await deleteFile(sessionId, filePath);
    if (!result.ok) {
      storeError(sessionId, filePath, result.error);
      return;
    }
    // The file leaves the dock on the next channel frame, and this tab is now
    // a view of something that is not there, so it goes with it.
    closeTransientTab(fileTabId(filePath));
  };

  const save = async (): Promise<void> => {
    if (sessionId === null || working === undefined || source === undefined) return;
    setSaving(true);
    const result = await saveFileContent(sessionId, filePath, working.hash, source);
    setSaving(false);
    if (result.ok) {
      setSaveNote('saved');
      setSource(undefined);
      markLoading(sessionId, filePath);
      const refreshed = await fetchFileDetail(sessionId, filePath);
      if (refreshed.ok) storeDetail(sessionId, refreshed.detail);
      else storeError(sessionId, filePath, refreshed.error);
      return;
    }
    setSaveNote(result.error);
  };

  return (
    <div data-testid="files-file-panel" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-doom-border px-4 py-2">
        <Breadcrumb path={relPath} data-testid="files-breadcrumb" className="min-w-0 flex-1" />
        {/* Edit is not one of the header's two toggles, so with neither lit the
            mode needs saying; picking either toggle leaves it. */}
        {view === 'edit' ? (
          <Badge tone="neutral" data-testid="files-editing" className="shrink-0 text-[8px]">
            editing
          </Badge>
        ) : null}
        {detail === undefined ? null : (
          <span className="shrink-0 text-[9px] text-doom-faint">
            +{detail.cumulative.additions} -{detail.cumulative.removals}
          </span>
        )}
        {/* The two ways of looking at the file sit in the header; the things
            that act on it live behind the kebab, so a destructive one is never
            a mis-click away from a view toggle. */}
        <nav className="flex shrink-0 items-center gap-1">
          {(['preview', 'diff'] as const).map((entry) => (
            <Button
              key={entry}
              variant={view === entry ? 'outline' : 'ghost'}
              size="xs"
              data-testid={`files-view-${entry}`}
              onClick={() => setView(entry)}
              className="text-[9px]"
            >
              {entry}
            </Button>
          ))}
        </nav>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="files-menu"
              title="file actions"
              className="shrink-0 text-doom-faint hover:text-doom-hi"
            >
              <KebabIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent data-testid="files-menu-list">
            <DropdownMenuItem
              data-testid="files-edit"
              disabled={working?.unavailable === true}
              onSelect={() => setView('edit')}
            >
              edit
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              data-testid="files-delete"
              disabled={working?.unavailable === true}
              onSelect={() => setConfirmingDelete(true)}
            >
              delete
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="files-close" onSelect={() => closeTransientTab(fileTabId(filePath))}>
              close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <DeleteFileDialog
        relPath={relPath}
        open={confirmingDelete}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      {loading && detail === undefined ? (
        <p data-testid="files-loading" className="px-4 py-3 text-[11px] text-doom-faint">
          reading this file's history…
        </p>
      ) : null}
      {error === undefined ? null : (
        <p data-testid="files-error" className="px-4 py-3 text-[11px] text-doom-red">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail === undefined ? null : view === 'diff' ? (
          <div className="flex flex-col">
            {detail.cumulative.note === undefined ? null : (
              <p data-testid="files-cumulative-note" className="px-4 py-2 text-[10px] text-doom-yellow">
                {detail.cumulative.note}
              </p>
            )}
            {detail.cumulative.hunks === undefined ? null : (
              <DiffView
                hunks={detail.cumulative.hunks}
                testId="files-cumulative-diff"
                onSelect={(selection) => openDraft(selection)}
              />
            )}
            <section className="mt-2 border-t border-doom-border">
              <h2 className="px-4 py-2 text-[10px] font-bold tracking-wide text-doom-faint uppercase">
                {detail.versions.length} {detail.versions.length === 1 ? 'change' : 'changes'} this session
              </h2>
              {detail.versions.map((version) => (
                <article key={version.index} data-testid={`files-version-${version.index}`}>
                  <Button
                    variant="ghost"
                    size="card"
                    data-testid={`files-version-toggle-${version.index}`}
                    onClick={() => setExpanded(expanded === version.index ? undefined : version.index)}
                    className="w-full gap-2 rounded-none px-4 py-1.5 hover:bg-doom-panel"
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span className="shrink-0 text-[9px] text-doom-faint">#{version.index}</span>
                      <span className="min-w-0 flex-1 truncate text-left text-[10px] text-doom-text">
                        {versionSummary(version)}
                      </span>
                      {version.origin === 'scan' ? (
                        <Badge tone="neutral" className="shrink-0 text-[8px]">
                          no baseline
                        </Badge>
                      ) : null}
                      <span className="shrink-0 text-[9px] text-doom-faint">
                        {expanded === version.index ? '▾' : '▸'}
                      </span>
                    </span>
                  </Button>
                  {expanded !== version.index ? null : version.hunks === undefined ? (
                    <p className="px-4 py-1.5 text-[10px] text-doom-faint">{version.note ?? 'nothing to show'}</p>
                  ) : (
                    <DiffView
                      hunks={version.hunks}
                      testId={`files-version-diff-${version.index}`}
                      onSelect={(selection) => openDraft(selection)}
                    />
                  )}
                </article>
              ))}
            </section>
          </div>
        ) : view === 'edit' ? (
          <div className="flex h-full flex-col gap-2 p-3">
            {working?.unavailable === true ? (
              <p data-testid="files-source-unavailable" className="text-[11px] text-doom-faint">
                {working.reason ?? 'this file cannot be shown'}
              </p>
            ) : (
              <>
                {/* The release, not the selection, is what raises the comment
                    box: the editor reports a range continuously through a drag
                    and the box takes focus when it opens. */}
                <div
                  className="min-h-[24rem] flex-1"
                  onMouseUp={openSelectionDraft}
                  onKeyUp={(event) => {
                    if (event.shiftKey) openSelectionDraft();
                  }}
                >
                  <CodeEditor
                    data-testid="files-source"
                    value={content}
                    path={relPath}
                    onChange={setSource}
                    onSelect={(range) => {
                      selection.current = range;
                    }}
                    className="h-full rounded border border-doom-border"
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="files-save"
                    loading={saving}
                    disabled={source === undefined || saving}
                    onClick={() => void save()}
                    className="text-[9px]"
                  >
                    save to disk
                  </Button>
                  {source === undefined ? null : (
                    <Button
                      variant="ghost"
                      size="xs"
                      data-testid="files-revert"
                      onClick={() => setSource(undefined)}
                      className="text-[9px]"
                    >
                      discard edits
                    </Button>
                  )}
                  {saveNote === undefined ? null : (
                    <span
                      data-testid="files-save-note"
                      className={saveNote === 'saved' ? 'text-[9px] text-doom-green' : 'text-[9px] text-doom-red'}
                    >
                      {saveNote}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div
            data-testid="files-preview"
            data-mode={previewMode}
            className={
              previewMode === 'code'
                ? 'flex h-full flex-col gap-2 p-4 text-[12px] text-doom-text'
                : 'flex flex-col gap-2 p-4 text-[12px] text-doom-text'
            }
            onMouseUp={() => {
              // Highlighted source knows which lines were picked, so a note on
              // it is anchored. A rendered document has no honest mapping back
              // to source lines, and a note there carries its quotation and
              // says it has none.
              if (previewMode === 'code') {
                openSelectionDraft();
                return;
              }
              const text = globalThis.getSelection?.()?.toString() ?? '';
              if (text.trim() !== '') openDraft({ snippet: text });
            }}
          >
            {/* A file the editor cannot hold is still a file the reader came
                to see, so the reason is said and the bytes are shown anyway. */}
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
              // The same editor the edit view uses, held open. Reading code as
              // flat text is the one thing a cockpit should never make anyone
              // do, and read-only keeps the two views honestly apart.
              <CodeEditor
                data-testid="files-preview-code"
                value={content}
                path={relPath}
                readOnly
                onSelect={(range) => {
                  selection.current = range;
                }}
                className="min-h-[24rem] flex-1 rounded border border-doom-border"
              />
            ) : (
              // Everything else is shown as it is written. Preview is the file
              // as it stands, so a file with nothing to render still has a
              // reading view rather than an empty pane.
              <pre
                data-testid="files-preview-text"
                className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.5] text-doom-text"
              >
                {content}
              </pre>
            )}
          </div>
        )}
      </div>

      {draft === undefined ? null : (
        <CommentDraft
          snippet={draft.snippet}
          {...(draft.startLine === undefined ? {} : { startLine: draft.startLine })}
          {...(draft.endLine === undefined ? {} : { endLine: draft.endLine })}
          onSubmit={submitDraft}
          onCancel={() => setDraft(undefined)}
        />
      )}

      {comments.length === 0 ? null : (
        <footer data-testid="files-review" className="shrink-0 border-t border-doom-border px-3 py-2">
          <div className="flex items-center gap-2 pb-1">
            <span className="flex-1 text-[10px] font-bold text-doom-hi">
              {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            </span>
            <Button
              variant="outline"
              size="xs"
              data-testid="files-send-review"
              onClick={sendReview}
              className="text-[9px]"
            >
              send review
            </Button>
          </div>
          {comments.map((comment) => (
            <div key={comment.id} data-testid="files-review-comment" className="flex items-start gap-2 py-0.5">
              <span className="shrink-0 text-[9px] text-doom-faint">{commentAnchor(comment)}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-doom-text">{comment.body}</span>
              <Button
                variant="ghost"
                size="xs"
                data-testid="files-review-remove"
                onClick={() => {
                  if (sessionId !== null) removeComment(sessionId, comment.id);
                }}
                className="shrink-0 text-[9px]"
              >
                remove
              </Button>
            </div>
          ))}
        </footer>
      )}
    </div>
  );
}

/** The transient tab one file opens in; the same file reopens rather than duplicating. */
export function fileTab(filePath: string, relPath: string): TransientTab {
  return {
    id: fileTabId(filePath),
    label: relPath.split('/').at(-1) ?? relPath,
    panel: (props) => <FilePanel {...props} filePath={filePath} relPath={relPath} />,
  };
}
