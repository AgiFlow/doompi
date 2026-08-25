import { Badge, Button, EmptyState } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useState } from 'react';
import type { WorkflowRunView } from '../src/types/webWorkflows.ts';
import type {
  WorkflowArtifactContentResponse,
  WorkflowArtifactsResponse,
  WorkflowArtifactView,
} from '../src/types/webWorkflowTerminal.ts';
import { fetchArtifact, fetchArtifacts } from './terminalApi.ts';

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

  return (
    <div data-testid="artifact-viewer" className="flex min-h-0 flex-1 flex-col px-[26px] py-[18px]">
      <div className="flex items-center gap-2.5 pb-3">
        <span className="truncate text-[12px] font-bold text-doom-hi">{path}</span>
        <Badge size="xs">artifact</Badge>
        <span className="text-[9px] text-doom-faint">
          {content === undefined ? '' : `${formatSize(content.size)} · written ${formatWhen(content.modifiedAt)}`}
        </span>
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="xs"
          data-testid="artifact-reload"
          onClick={() => setReloads((count) => count + 1)}
        >
          reload
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-doom-border bg-doom-deep px-4 py-3">
        {error === undefined ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-doom-text">
            {content?.text ?? ''}
          </pre>
        ) : (
          <span data-testid="artifact-error" className="text-[10px] text-doom-yellow">
            {error}
          </span>
        )}
      </div>
      {content?.truncated === true ? (
        <span className="pt-2 text-[9px] text-doom-faint">
          this is the head of the file; the rest is on disk at the path above
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
