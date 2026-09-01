import { Badge, Button, EmptyState, Markdown } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useState } from 'react';
import type { WorkflowRunView } from '../types/webWorkflows.ts';
import type {
  WorkflowArtifactContentResponse,
  WorkflowArtifactsResponse,
  WorkflowArtifactView,
} from '../types/webWorkflowTerminal.ts';
import { artifactContentUrl, fetchArtifact, fetchArtifacts } from './terminalApi.ts';

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
      <table data-testid="artifact-table" className="min-w-full border-collapse font-mono text-[11px]">
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
        className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-doom-text"
      >
        {text}
      </pre>
    ) : (
      <div data-testid="artifact-markdown" className="max-w-5xl text-[13px] text-doom-text">
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
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-doom-text">
        {formatted}
      </pre>
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
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-doom-text">{text}</pre>
    );
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
}: WebPluginSlotProps & { workspace: string; runKey: string; path: string }) {
  const [content, setContent] = useState<WorkflowArtifactContentResponse>();
  const [error, setError] = useState<string>();
  const [reloads, setReloads] = useState(0);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchArtifact(workspace, runKey, path).then((result) => {
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
  }, [workspace, runKey, path, reloads]);

  const rawUrl = artifactContentUrl(workspace, runKey, path);
  const downloadUrl = artifactContentUrl(workspace, runKey, path, true);
  const mimeType = content === undefined ? undefined : previewMimeType(content);
  const isMarkdown = mimeType === 'text/markdown';

  return (
    <div data-testid="artifact-viewer" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
      <div className="flex items-center gap-2.5 pb-3">
        <span className="truncate text-[12px] font-bold text-doom-hi">{path}</span>
        <Badge size="xs">{mimeType ?? 'artifact'}</Badge>
        <span className="text-[9px] text-doom-faint">
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
          <span data-testid="artifact-error" className="text-[10px] text-doom-yellow">
            {error}
          </span>
        ) : content === undefined ? (
          <span className="text-[10px] text-doom-faint">loading preview</span>
        ) : (
          <ArtifactPreview content={content} rawUrl={rawUrl} raw={raw} />
        )}
      </div>
      {content?.truncated === true ? (
        <span className="pt-2 text-[9px] text-doom-faint">
          this preview shows the first {formatSize(content.text?.length)}; download the artifact for the complete file
        </span>
      ) : null}
    </div>
  );
}

/**
 * The run directory, as the run pane's second tab.
 *
 * The workflow's own declaration leads, in the order it was written and
 * including entries no job has produced yet, because the declaration is what
 * the run is for. What the folder holds besides that follows.
 */
export function ArtifactsPane({ run, onOpen }: { run: WorkflowRunView; onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<WorkflowArtifactsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void fetchArtifacts(run.workspace, run.runKey).then((result) => {
        if (!live) return;
        if ('error' in result) {
          setError(result.error);
          return;
        }
        setError(undefined);
        setListing(result.artifacts);
      });
    };
    read();
    // A running workflow writes while the pane is open; a settled one cannot,
    // so it is read once and left alone.
    if (run.stage !== 'running') return;
    const timer = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [run.workspace, run.runKey, run.stage]);

  const declared = listing?.artifacts.filter((entry) => entry.declared) ?? [];
  const found = listing?.artifacts.filter((entry) => !entry.declared) ?? [];

  const Row = ({ entry }: { entry: WorkflowArtifactView }) => {
    const glyph = STATE_GLYPH[entry.state];
    const openable = entry.kind === 'file' && entry.state !== 'pending';
    return (
      <button
        type="button"
        data-testid={`artifact-row-${entry.path}`}
        data-artifact-state={entry.state}
        disabled={!openable}
        onClick={() => onOpen(entry.path)}
        className={`flex flex-col gap-0.5 px-3 py-1.5 text-left ${openable ? 'cursor-pointer hover:bg-doom-panel' : 'cursor-default'}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`w-3 shrink-0 text-[10px] ${glyph.className}`}>{glyph.glyph}</span>
          <span className={`truncate text-[11px] ${entry.state === 'pending' ? 'text-doom-dim' : 'text-doom-hi'}`}>
            {entry.path}
          </span>
          {entry.producedBy.length === 0 ? null : (
            <Badge size="xs" tone="violet" className="shrink-0">
              {entry.producedBy.join(', ')}
            </Badge>
          )}
          <span className="min-w-0 flex-1" />
          <span className="shrink-0 text-[9px] text-doom-faint">
            {entry.state === 'pending'
              ? 'not written yet'
              : `${formatSize(entry.size)} · ${formatWhen(entry.modifiedAt)}`}
          </span>
        </span>
        {entry.description === '' ? null : (
          <span className="truncate pl-5 text-[9px] text-doom-faint">{entry.description}</span>
        )}
      </button>
    );
  };

  return (
    <div data-testid="artifacts-pane" className="flex min-h-0 flex-1 flex-col">
      {error !== undefined ? (
        <EmptyState className="py-4" title="the run directory cannot be read" description={error} />
      ) : null}
      {declared.length === 0 && found.length === 0 && error === undefined ? (
        <EmptyState className="py-4" title="nothing in the run directory yet" />
      ) : null}
      {declared.length === 0 ? null : (
        <>
          <span className="px-3 pb-1 pt-2 text-[9px] font-bold tracking-[0.14em] text-doom-faint">
            DECLARED · {listing?.description || 'run-directory'}
          </span>
          {declared.map((entry) => (
            <Row key={entry.path} entry={entry} />
          ))}
        </>
      )}
      {found.length === 0 ? null : (
        <>
          <span className="px-3 pb-1 pt-3 text-[9px] font-bold tracking-[0.14em] text-doom-faint">
            ALSO IN THE FOLDER
          </span>
          {found.map((entry) => (
            <Row key={entry.path} entry={entry} />
          ))}
        </>
      )}
      {listing === undefined ? null : (
        <span className="truncate px-3 py-2 text-[9px] text-doom-faint">{listing.runDir}</span>
      )}
    </div>
  );
}
