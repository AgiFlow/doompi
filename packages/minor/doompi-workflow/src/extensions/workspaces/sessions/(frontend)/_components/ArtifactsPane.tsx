import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Badge, Button, EmptyState, Markdown } from '@agimon-ai/doompi-web-components';
import { useEffect, useState, type ReactNode } from 'react';

import type { WorkflowRunView } from '../../../../../types/webWorkflows';
import type {
  WorkflowArtifactContentResponse,
  WorkflowArtifactsResponse,
  WorkflowArtifactView,
} from '../../../../../types/webWorkflowTerminal';
import { artifactContentUrl, fetchArtifact, fetchArtifacts, openRunDirectory } from '../_lib/terminalApi';

const TAB_ID_PREFIX = 'workflows-artifact-';
const BYTES_PER_UNIT = 1024;
const UNITS = ['B', 'KB', 'MB'] as const;

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATE_GLYPH: Readonly<Record<WorkflowArtifactView['state'], { glyph: string; className: string }>> = {
  written: { glyph: '✓', className: 'text-doom-green' },
  empty: { glyph: '○', className: 'text-doom-yellow' },
  pending: { glyph: '○', className: 'text-doom-faint' },
  unreadable: { glyph: '!', className: 'text-doom-red' },
};

function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index <= text.length && rows.length < 500; index += 1) {
    const character = text[index] ?? '\n';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  return rows;
}

function DelimitedPreview({ text, delimiter }: { text: string; delimiter: ',' | '\t' }) {
  const rows = parseDelimited(text, delimiter);
  const [head = [], ...body] = rows;
  return (
    <div className="overflow-auto">
      <table data-testid="artifact-table" className="min-w-full border-collapse font-mono text-sm">
        <thead className="sticky top-0 bg-doom-panel text-doom-hi">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="border border-doom-border px-2 py-1.5 text-left font-bold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="border border-doom-border px-2 py-1 align-top text-doom-text">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Keeps a newly built viewer compatible while an older hub process is restarting. */
function previewMimeType(content: WorkflowArtifactContentResponse): string {
  if (content.mimeType !== undefined) return content.mimeType;
  const extension = content.path.split('.').pop()?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'json') return 'application/json';
  if (extension === 'csv') return 'text/csv';
  if (extension === 'tsv') return 'text/tab-separated-values';
  if (extension === 'html' || extension === 'htm') return 'text/html';
  if (extension === 'pdf') return 'application/pdf';
  if (['bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension ?? '')) return 'image/unknown';
  if (['aac', 'm4a', 'mp3', 'oga', 'ogg', 'wav'].includes(extension ?? '')) return 'audio/unknown';
  if (['mov', 'mp4', 'ogv', 'webm'].includes(extension ?? '')) return 'video/unknown';
  return content.text === undefined ? 'application/octet-stream' : 'text/plain';
}

function ArtifactPreview({
  content,
  rawUrl,
  raw,
}: {
  content: WorkflowArtifactContentResponse;
  rawUrl: string;
  raw: boolean;
}) {
  const text = content.text ?? '';
  const mimeType = previewMimeType(content);
  if (content.size === 0) {
    return (
      <EmptyState
        data-testid="artifact-empty"
        title="this artifact is empty"
        description="The workflow created the file but did not write any content."
      />
    );
  }
  if (mimeType === 'text/markdown') {
    return raw ? (
      <pre
        data-testid="artifact-raw"
        className="whitespace-pre-wrap break-words font-mono text-sm leading-snug text-doom-text"
      >
        {text}
      </pre>
    ) : (
      <div data-testid="artifact-markdown" className="max-w-5xl text-base text-doom-text">
        <Markdown text={text} />
      </div>
    );
  }
  if (mimeType === 'application/json') {
    let formatted = text;
    try {
      formatted = JSON.stringify(JSON.parse(text) as unknown, null, 2);
    } catch {
      // An incomplete file remains useful as literal text while a workflow writes it.
    }
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-snug text-doom-text">{formatted}</pre>
    );
  }
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') {
    return <DelimitedPreview text={text} delimiter={mimeType === 'text/csv' ? ',' : '\t'} />;
  }
  if (mimeType === 'text/html') {
    return (
      <iframe
        data-testid="artifact-html"
        title={content.path}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={text}
        className="min-h-[520px] w-full rounded bg-white"
      />
    );
  }
  if (mimeType.startsWith('image/')) {
    return (
      <img
        data-testid="artifact-image"
        src={rawUrl}
        alt={content.path}
        className="max-h-full max-w-full object-contain"
      />
    );
  }
  if (mimeType === 'application/pdf') {
    return (
      <object
        data-testid="artifact-pdf"
        data={rawUrl}
        type="application/pdf"
        aria-label="PDF artifact"
        className="min-h-[600px] w-full"
      />
    );
  }
  if (mimeType.startsWith('audio/')) {
    return (
      <audio data-testid="artifact-audio" src={rawUrl} controls preload="metadata" className="w-full">
        <track kind="captions" />
      </audio>
    );
  }
  if (mimeType.startsWith('video/')) {
    return (
      <video data-testid="artifact-video" src={rawUrl} controls preload="metadata" className="max-h-full max-w-full">
        <track kind="captions" />
      </video>
    );
  }
  if (content.text !== undefined) {
    return <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-snug text-doom-text">{text}</pre>;
  }
  return (
    <EmptyState title="preview unavailable" description="Download this artifact to open it with a local application." />
  );
}

/** One artifact, read-only, in its own tab. */
export function artifactTab(run: WorkflowRunView, path: string): TransientTab {
  return {
    id: `${TAB_ID_PREFIX}${run.workspace}-${run.runKey}-${path}`.replace(/[^\w-]+/g, '-'),
    label: path.split('/').pop() ?? path,
    panel: (props: WebPluginSlotProps) => (
      <ArtifactViewerPanel {...props} workspace={run.workspace} runKey={run.runKey} path={path} />
    ),
  };
}

/**
 * One artifact's text.
 *
 * Read-only and reloadable: a run keeps writing while somebody is reading, and
 * the file on the next read is the one that matters.
 */
export function ArtifactViewerPanel({
  workspace,
  runKey,
  path,
  sessionId,
}: WebPluginSlotProps & { workspace: string; runKey: string; path: string }) {
  const [content, setContent] = useState<WorkflowArtifactContentResponse>();
  const [error, setError] = useState<string>();
  const [reloads, setReloads] = useState(0);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchArtifact(workspace, runKey, path, sessionId).then((result) => {
      if (!live) return;
      if ('error' in result) {
        setError(result.error);
        setContent(undefined);
        return;
      }
      setError(undefined);
      setContent(result.artifact);
    });
    return () => {
      live = false;
    };
  }, [workspace, runKey, path, reloads, sessionId]);

  const rawUrl = artifactContentUrl(workspace, runKey, path, false, sessionId);
  const downloadUrl = artifactContentUrl(workspace, runKey, path, true, sessionId);
  const mimeType = content === undefined ? undefined : previewMimeType(content);
  const isMarkdown = mimeType === 'text/markdown';

  return (
    <div data-testid="artifact-viewer" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
      <div className="flex items-center gap-2.5 pb-3">
        <span className="truncate text-sm font-bold text-doom-hi">{path}</span>
        <Badge size="xs">{mimeType ?? 'artifact'}</Badge>
        <span className="text-2xs text-doom-faint">
          {content === undefined ? '' : `${formatSize(content.size)} · written ${formatWhen(content.modifiedAt)}`}
        </span>
        <span className="min-w-0 flex-1" />
        {isMarkdown ? (
          <div className="flex items-center">
            <Button
              variant={raw ? 'outline' : 'primary'}
              size="xs"
              data-testid="artifact-rendered-toggle"
              onClick={() => setRaw(false)}
            >
              rendered
            </Button>
            <Button
              variant={raw ? 'primary' : 'outline'}
              size="xs"
              data-testid="artifact-raw-toggle"
              onClick={() => setRaw(true)}
            >
              raw
            </Button>
          </div>
        ) : null}
        <Button asChild variant="ghost" size="xs">
          <a data-testid="artifact-download" href={downloadUrl} download>
            download
          </a>
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-testid="artifact-reload"
          onClick={() => setReloads((count) => count + 1)}
        >
          reload
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-doom-border bg-doom-deep p-4">
        {error !== undefined ? (
          <span data-testid="artifact-error" className="text-xs text-doom-yellow">
            {error}
          </span>
        ) : content === undefined ? (
          <span className="text-xs text-doom-faint">loading preview</span>
        ) : (
          <ArtifactPreview content={content} rawUrl={rawUrl} raw={raw} />
        )}
      </div>
      {content?.truncated === true ? (
        <span className="pt-2 text-2xs text-doom-faint">
          this preview shows the first {formatSize(content.text?.length)}; download the artifact for the complete file
        </span>
      ) : null}
    </div>
  );
}

/** The run's file tree, including declared outputs that have not been written yet. */
export function ArtifactsPane({
  run,
  sessionId,
  onOpen,
}: {
  run: WorkflowRunView;
  sessionId: string | null;
  onOpen: (path: string) => void;
}) {
  const [listing, setListing] = useState<WorkflowArtifactsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Cleared on every change, settled runs included, so a slow answer for the previous run or
    // session never overwrites this one. One read at a time keeps a slow hub from piling up polls.
    let live = true;
    let reading = false;
    const read = (): void => {
      if (reading) return;
      reading = true;
      void fetchArtifacts(run.workspace, run.runKey, sessionId)
        .then((result) => {
          if (!live) return;
          if ('error' in result) {
            setError(result.error);
            return;
          }
          setError(undefined);
          setListing(result.artifacts);
        })
        .finally(() => {
          reading = false;
        });
    };
    read();
    // A running workflow writes while the pane is open; a settled one cannot,
    // so it is read once and left alone.
    const timer = run.stage === 'running' ? setInterval(read, 5_000) : undefined;
    return () => {
      live = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [run.workspace, run.runKey, run.stage, sessionId]);

  return (
    <ArtifactList
      listing={listing}
      error={error}
      onLoadDirectory={(directory) => fetchArtifacts(run.workspace, run.runKey, sessionId, directory)}
      onOpen={onOpen}
      onOpenDirectory={() => openRunDirectory(run.workspace, run.runKey, sessionId)}
    />
  );
}

/** Directory-first file tree with declared output metadata and lazy folder reads. */
export function ArtifactList({
  listing,
  error,
  onOpen,
  onOpenDirectory,
  onLoadDirectory,
}: {
  listing: WorkflowArtifactsResponse | undefined;
  error: string | undefined;
  onOpen: (path: string) => void;
  onOpenDirectory?: () => Promise<{ error?: string }>;
  onLoadDirectory?: (path: string) => Promise<{ artifacts: WorkflowArtifactsResponse } | { error: string }>;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string>();
  const openDirectory = async (): Promise<void> => {
    if (onOpenDirectory === undefined || opening) return;
    setOpening(true);
    setOpenError(undefined);
    try {
      const result = await onOpenDirectory();
      setOpenError(result.error);
    } catch {
      setOpenError('The run folder could not be opened in Finder.');
    } finally {
      setOpening(false);
    }
  };
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Record<string, WorkflowArtifactView[]>>({});
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const entries = new Map<string, WorkflowArtifactView>();
  for (const entry of [...Object.values(loaded).flat(), ...(listing?.artifacts ?? [])]) entries.set(entry.path, entry);
  for (const entry of entries.values()) {
    const parts = entry.path.split('/');
    parts.pop();
    while (parts.length > 0) {
      const parent = parts.join('/');
      if (!entries.has(parent))
        entries.set(parent, {
          path: parent,
          kind: 'directory',
          description: '',
          producedBy: [],
          declared: false,
          state: entry.state === 'pending' ? 'pending' : 'written',
        });
      parts.pop();
    }
  }
  const toggle = async (entry: WorkflowArtifactView): Promise<void> => {
    const closing = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (closing) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (closing || loading.has(entry.path) || onLoadDirectory === undefined || entry.state === 'pending') return;
    setLoading((current) => new Set(current).add(entry.path));
    try {
      const result = await onLoadDirectory(entry.path);
      if ('error' in result) setFolderErrors((current) => ({ ...current, [entry.path]: result.error }));
      else {
        setLoaded((current) => ({ ...current, [entry.path]: result.artifacts.artifacts }));
        setFolderErrors((current) => ({ ...current, [entry.path]: '' }));
      }
    } catch {
      setFolderErrors((current) => ({ ...current, [entry.path]: 'The folder cannot be read.' }));
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
    }
  };

  const renderRow = (entry: WorkflowArtifactView) => {
    const glyph = STATE_GLYPH[entry.state];
    const openable = entry.kind === 'directory' || entry.state !== 'pending';
    return (
      <button
        type="button"
        data-testid={`artifact-row-${entry.path}`}
        data-artifact-state={entry.state}
        disabled={!openable}
        aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
        onClick={() => (entry.kind === 'directory' ? void toggle(entry) : onOpen(entry.path))}
        className={`flex flex-col gap-0.5 px-3 py-1.5 text-left ${openable ? 'cursor-pointer hover:bg-doom-panel' : 'cursor-default'}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`w-3 shrink-0 text-xs ${glyph.className}`}>
            {entry.kind === 'directory' ? (expanded.has(entry.path) ? '▾' : '▸') : glyph.glyph}
          </span>
          <span
            title={entry.path}
            className={`min-w-0 flex-1 truncate text-xs ${entry.state === 'pending' ? 'text-doom-dim' : 'text-doom-hi'}`}
          >
            {entry.path.split('/').pop()}
            {entry.kind === 'directory' ? '/' : ''}
          </span>
          <span className="shrink-0 text-2xs text-doom-faint">
            {entry.state === 'pending'
              ? 'pending'
              : entry.kind === 'directory'
                ? ''
                : [formatSize(entry.size), formatWhen(entry.modifiedAt)].filter(Boolean).join(' · ')}
          </span>
        </span>
        {entry.declared || entry.producedBy.length > 0 || entry.description !== '' ? (
          <span className="flex min-w-0 items-center gap-1 pl-5 text-2xs text-doom-faint">
            {entry.declared ? (
              <Badge size="xs" tone="violet" className="shrink-0">
                declared
              </Badge>
            ) : null}
            {entry.producedBy.length === 0 ? null : (
              <span title={entry.producedBy.join(', ')} className="truncate">
                {entry.producedBy.join(', ')}
              </span>
            )}
            {entry.description === '' ? null : (
              <span title={entry.description} className="truncate">
                {entry.description}
              </span>
            )}
          </span>
        ) : null}
      </button>
    );
  };

  const renderChildren = (parent: string): ReactNode => {
    const children = [...entries.values()]
      .filter((entry) => {
        const cut = entry.path.lastIndexOf('/');
        return (cut === -1 ? '' : entry.path.slice(0, cut)) === parent;
      })
      .sort(
        (left, right) =>
          Number(right.kind === 'directory') - Number(left.kind === 'directory') || left.path.localeCompare(right.path),
      );
    return children.map((entry) => (
      <div key={entry.path} className="flex flex-col">
        {renderRow(entry)}
        {entry.kind === 'directory' && expanded.has(entry.path) ? (
          <div className="ml-3 border-l border-doom-border pl-1">
            {loading.has(entry.path) ? <span className="px-3 text-xs text-doom-faint">loading…</span> : null}
            {folderErrors[entry.path] ? (
              <span role="alert" className="px-3 text-xs text-doom-yellow">
                {folderErrors[entry.path]}
              </span>
            ) : null}
            {renderChildren(entry.path)}
          </div>
        ) : null}
      </div>
    ));
  };

  return (
    <div data-testid="artifacts-pane" className="flex min-h-0 flex-1 flex-col">
      {error !== undefined ? (
        <EmptyState className="py-4" title="the run directory cannot be read" description={error} />
      ) : null}
      {entries.size === 0 && error === undefined ? (
        <EmptyState className="py-4" title="nothing in the run directory yet" />
      ) : null}
      {listing?.description ? <span className="px-3 py-2 text-2xs text-doom-faint">{listing.description}</span> : null}
      {renderChildren('')}
      {openError === undefined ? null : (
        <span role="alert" className="px-3 text-xs text-doom-yellow">
          {openError}
        </span>
      )}
      {listing === undefined ? null : (
        <button
          type="button"
          data-testid="workflow-open-directory"
          aria-label="Open workflow folder in Finder"
          title={`${listing.runDir} (open in Finder)`}
          disabled={opening || onOpenDirectory === undefined}
          onClick={() => void openDirectory()}
          className="truncate px-3 py-2 text-left text-2xs text-doom-faint hover:text-doom-hi disabled:cursor-default"
        >
          {listing.runDir}
        </button>
      )}
    </div>
  );
}
