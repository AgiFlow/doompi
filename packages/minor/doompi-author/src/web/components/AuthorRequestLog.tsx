import type { AuthorNativeAnchor, AuthorRequestRecord } from '../lib/authorViewportTypes.ts';

const STATUS_LABELS: Record<AuthorRequestRecord['status'], string> = {
  REQUESTED: 'Request queued',
  CHANGING: 'Agent working',
  CHANGED: 'Change ready',
  COMPLETE: 'Request completed',
  FAILED: 'Request failed',
  CANCELLED: 'Request cancelled',
};

const STATUS_STYLES: Record<AuthorRequestRecord['status'], string> = {
  REQUESTED: 'border-doom-yellow/35 bg-doom-yellow/5 text-doom-yellow',
  CHANGING: 'border-doom-magenta/45 bg-doom-magenta/10 text-doom-yellow',
  CHANGED: 'border-doom-cyan/40 bg-doom-cyan/5 text-doom-cyan',
  COMPLETE: 'border-doom-green/40 bg-doom-green/5 text-doom-green',
  FAILED: 'border-doom-red/45 bg-doom-red/10 text-doom-red',
  CANCELLED: 'border-doom-border bg-doom-panel text-doom-dim',
};

function requestInstruction(requestText: string): string {
  const referencedContext = requestText.search(/(?:^|\s+)Referenced context "/u);
  return requestText
    .slice(0, referencedContext < 0 ? undefined : referencedContext)
    .replace(/^Please address the attached feedback\.\s*Request ID: \S+\s*/u, '')
    .trim();
}

function documentName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) || path;
}

function anchorLabel(anchor: AuthorNativeAnchor): string {
  switch (anchor.kind) {
    case 'text-range':
      return anchor.startLine === anchor.endLine
        ? `Line ${anchor.startLine}`
        : `Lines ${anchor.startLine}–${anchor.endLine}`;
    case 'cell':
      return [anchor.sheet, anchor.location].filter(Boolean).join(' · ');
    case 'slide-element':
      return `Slide ${anchor.slide} · ${anchor.location}`;
    case 'image-rect':
      return 'Image region';
    case 'pdf-page-rect':
      return `Page ${anchor.page}`;
    case 'video-time-rect': {
      const minutes = Math.floor(anchor.timeSeconds / 60);
      const seconds = Math.floor(anchor.timeSeconds % 60)
        .toString()
        .padStart(2, '0');
      return `Video ${minutes}:${seconds}`;
    }
  }
}

function progressLabel(request: AuthorRequestRecord): string {
  const total = request.regions.length;
  const pending = request.pendingRegions?.length;
  if (request.status === 'CHANGING' && request.currentOperation === 'Agent is working on this request')
    return 'Processing request';
  if (request.status === 'CHANGING' && pending !== undefined) return `${total - pending} of ${total} regions applied`;
  if (request.status === 'CHANGED') return 'Changes applied · awaiting save';
  if (request.status === 'COMPLETE') return 'Agent finished processing this request';
  if (request.status === 'FAILED') return 'Stopped with an error';
  if (request.status === 'CANCELLED') return 'Stopped before completion';
  return `${total} region${total === 1 ? '' : 's'} queued`;
}

function RequestRecord({ request, prominent = false }: { request: AuthorRequestRecord; prominent?: boolean }) {
  const instruction = requestInstruction(request.requestText);
  return (
    <article data-testid={prominent ? 'author-active-request' : undefined} className="space-y-3">
      <header className="border-b border-doom-border-soft pb-3">
        <p className="text-2xs font-bold tracking-widest text-doom-faint">DOCUMENT CONTEXT</p>
        <p className="mt-2 flex items-center gap-2 truncate text-base font-bold text-doom-hi">
          <span aria-hidden className="text-doom-magenta">
            ↗
          </span>
          {documentName(request.documentPath)}
        </p>
      </header>

      <section aria-label="Request locations" className="rounded border border-doom-border bg-doom-panel p-3">
        <ol className="space-y-3">
          {request.regions.map((region, index) => (
            <li key={region.id} className="space-y-2">
              <p className="font-mono text-2xs font-bold uppercase tracking-wider text-doom-yellow">
                WHERE · {request.regions.length > 1 ? `${index + 1} · ` : ''}
                {documentName(request.documentPath)} / {anchorLabel(region.anchor)} · rev {request.revision}
              </p>
              {region.quote ? (
                <blockquote className="line-clamp-3 text-sm italic leading-relaxed text-doom-text">
                  “{region.quote}”
                </blockquote>
              ) : null}
              <p className="text-xs leading-relaxed text-doom-dim">{region.comment}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        data-testid={prominent ? 'author-operation-card' : undefined}
        className={`rounded border p-3 ${STATUS_STYLES[request.status]}`}
      >
        <p className="font-mono text-xs font-bold tracking-wider">
          ●{' '}
          {request.status === 'CHANGING'
            ? 'WORKING'
            : request.status === 'COMPLETE'
              ? 'COMPLETED'
              : request.status === 'FAILED'
                ? 'ERROR'
                : request.status}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-doom-hi">
          {request.currentOperation || STATUS_LABELS[request.status]}
        </p>
        {request.error ? <p className="mt-2 text-xs leading-relaxed text-doom-red">{request.error}</p> : null}
        {request.before !== undefined || request.after !== undefined ? (
          <details className="mt-2 border-t border-current/20 pt-2 text-xs text-doom-dim">
            <summary className="cursor-pointer select-none">change preview</summary>
            {request.before !== undefined ? (
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono">
                before: {request.before}
              </pre>
            ) : null}
            {request.after !== undefined ? (
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono">
                after: {request.after}
              </pre>
            ) : null}
          </details>
        ) : null}
      </section>

      <section className="space-y-2">
        <p className="text-2xs font-bold tracking-widest text-doom-faint">REQUEST · HOW TO CHANGE</p>
        <div className="rounded border border-doom-border bg-doom-deep p-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-doom-text">
            {instruction || 'No additional instruction.'}
          </p>
        </div>
      </section>

      <footer className="font-mono text-2xs text-doom-dim">{progressLabel(request)}</footer>
    </article>
  );
}

export function AuthorRequestLog({ requests }: { requests: readonly AuthorRequestRecord[] }) {
  const latest = requests.at(-1);
  const earlier = requests.slice(0, -1).toReversed();
  return (
    <section data-testid="author-request-history" className="space-y-3">
      <h3 className="text-2xs font-bold tracking-widest text-doom-faint">AUTHORING</h3>
      {latest === undefined ? (
        <p className="text-sm leading-relaxed text-doom-dim">No requests or changes yet.</p>
      ) : (
        <RequestRecord request={latest} prominent />
      )}
      {earlier.length > 0 ? (
        <details className="border-t border-doom-border-soft pt-3" data-testid="author-earlier-requests">
          <summary className="cursor-pointer select-none text-2xs font-bold tracking-wider text-doom-faint">
            EARLIER REQUESTS ({earlier.length})
          </summary>
          <ol className="mt-3 space-y-5">
            {earlier.map((request) => (
              <li key={request.id}>
                <RequestRecord request={request} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
