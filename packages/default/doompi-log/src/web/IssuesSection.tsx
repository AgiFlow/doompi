import { Button, Spinner } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import { isIssuesUnavailable, type IssuesView, type MetricsTool } from '../types/webMetrics.ts';
import { IssuesDetail } from './IssuesDetail.tsx';
import { fetchIssues } from './metricsApi.ts';

/**
 * The detail behind the issue count.
 *
 * Collapsed until asked for, because the hub answers this from a subprocess:
 * the running log sink serves no issues route over HTTP. Opening it is the
 * reader agreeing to that cost, which is better than making every refresh of
 * the whole page wait on the slowest transport.
 *
 * Only the going-and-getting lives here; IssuesDetail owns what the numbers
 * look like once they arrive.
 */

interface IssuesSectionProps {
  /** Tool call counts from the report, used as the denominator. */
  tools: readonly MetricsTool[];
  /** The dimension value the page is narrowed to, forwarded as a session filter. */
  focus?: string;
}

export function IssuesSection({ tools, focus }: IssuesSectionProps) {
  const [view, setView] = useState<IssuesView | undefined>(undefined);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = (): void => {
    setOpen(true);
    setLoading(true);
    setMessage('');
    void fetchIssues(focus).then((result) => {
      setLoading(false);
      if ('error' in result) {
        if (result.error !== '') setMessage(result.error);
        return;
      }
      if (isIssuesUnavailable(result.issues)) {
        setMessage(result.issues.detail);
        return;
      }
      setView(result.issues);
    });
  };

  return (
    <section className="flex flex-col gap-1" data-testid="metrics-issues">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold text-doom-faint">issues</span>
        {open ? null : (
          <Button variant="ghost" size="xs" className="text-[9px]" onClick={load} data-testid="metrics-issues-open">
            show detail
          </Button>
        )}
        {open && !loading ? (
          <Button variant="ghost" size="xs" className="text-[9px]" onClick={load} data-testid="metrics-issues-reload">
            reload
          </Button>
        ) : null}
        {loading ? <Spinner /> : null}
      </div>
      {/* Reading this scans the whole window in a subprocess, so the reader is
          told why it is behind a click rather than left wondering. */}
      {open ? null : (
        <span className="text-[9px] text-doom-faint/70">
          the log sink has no issues endpoint, so this is read separately and takes a moment
        </span>
      )}

      {message === '' ? null : (
        <span className="text-[10px] text-doom-yellow" data-testid="metrics-issues-message">
          {message}
        </span>
      )}

      {view === undefined ? null : <IssuesDetail view={view} tools={tools} />}
    </section>
  );
}
