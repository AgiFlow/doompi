import { Button, Spinner } from '@agimon-ai/doompi-web-components';
import { useEffect, useId, useRef, useState } from 'react';

import { isIssuesUnavailable, type IssuesView, type MetricsTool } from '../../../../types/webMetrics';
import { fetchIssues } from '../_lib/metricsApi';
import { IssuesDetail } from './IssuesDetail';

interface IssuesSectionProps {
  tools: readonly MetricsTool[];
  focus?: string;
  count?: number;
  startTime?: string;
  endTime?: string;
  broaderScope?: boolean;
}

/** Issue analysis is an explicit read, not another request on every metrics refresh. */
export function IssuesSection({ tools, focus, count, startTime, endTime, broaderScope = false }: IssuesSectionProps) {
  const [view, setView] = useState<IssuesView>();
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const detailsId = useId();
  useEffect(() => {
    pending.current?.abort();
    setView(undefined);
    setMessage('');
    setLoading(false);
    setOpen(false);
    return () => pending.current?.abort();
  }, [focus, startTime, endTime]);

  const load = (): void => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setOpen(true);
    setLoading(true);
    setMessage('');
    setView(undefined);
    void fetchIssues(focus, controller.signal, { startTime, endTime })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        if ('error' in result) setMessage(result.error || 'Issue details could not be loaded.');
        else if (isIssuesUnavailable(result.issues)) setMessage(result.issues.detail);
        else setView(result.issues);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setMessage(error instanceof Error ? error.message : 'Issue details could not be loaded.');
      });
  };
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-doom-border bg-doom-panel p-4"
      data-testid="metrics-issues"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-doom-hi">
            Issues to investigate{count === undefined ? '' : ` · ${count} ${count === 1 ? 'issue' : 'issues'}`}
          </h3>
          <p className="mt-1 text-sm text-doom-dim">Inspect recurring failures and the evidence behind them.</p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? <Spinner label="Reading issue details" /> : null}
          <Button
            variant="outline"
            size="md"
            disabled={loading}
            onClick={load}
            aria-expanded={open}
            aria-controls={detailsId}
            data-testid={open ? 'metrics-issues-reload' : 'metrics-issues-open'}
          >
            {open ? 'Reload details' : 'Inspect issues'}
          </Button>
          {open ? (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                pending.current?.abort();
                setLoading(false);
                setOpen(false);
              }}
              aria-controls={detailsId}
            >
              Hide
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-doom-dim">
        Details are loaded on demand.{' '}
        {startTime === undefined
          ? endTime === undefined
            ? 'This hub did not report a time window; details cover all available history.'
            : 'Details cover available history up to report time; no start bound was supplied.'
          : 'Details use the report’s recorded time window.'}{' '}
        {broaderScope
          ? 'LogSink cannot filter issue details by model, provider or agent, so this analysis covers all groups in that window.'
          : focus === undefined
            ? 'Analysis covers all groups.'
            : 'Filtered to this session.'}
      </p>
      <div id={detailsId} hidden={!open} aria-busy={loading}>
        {message === '' ? null : (
          <p
            role="alert"
            className="rounded-md border border-doom-edge-yellow bg-doom-tint-yellow p-3 text-sm text-doom-yellow"
            data-testid="metrics-issues-message"
          >
            {message}
          </p>
        )}
        {loading ? (
          <p role="status" className="py-3 text-sm text-doom-dim">
            Reading recorded incidents...
          </p>
        ) : null}
        {view === undefined ? null : (
          <IssuesDetail view={view} tools={broaderScope ? [] : tools} summaryCount={broaderScope ? undefined : count} />
        )}
      </div>
    </section>
  );
}
