import type { SettingsPanelProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import {
  isMetricsUnavailable,
  METRICS_DIMENSIONS,
  METRICS_PERIODS,
  type MetricsDimension,
  type MetricsPeriod,
} from '../../../../types/webMetrics';
import { fetchMetrics, type MetricsResult } from '../_lib/metricsApi';
import { EmptyForReason, FocusNotice, MetricsLoading } from './MetricsNotice';
import { DIMENSION_LABELS, MetricsReportView } from './MetricsReportView';

const PERIOD_LABELS: Record<MetricsPeriod, string> = {
  day: 'Past day',
  week: 'Past week',
  month: 'Past month',
  all: 'All history',
};

/** Only render a response under the controls that requested it. */
export function MetricsPanel(_props: SettingsPanelProps) {
  const [dimension, setDimension] = useState<MetricsDimension>('model');
  const [period, setPeriod] = useState<MetricsPeriod>('week');
  const [focus, setFocus] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [completed, setCompleted] = useState<{ key: string; result: MetricsResult }>();
  const requestKey = JSON.stringify([dimension, period, focus, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMetrics(dimension, period, focus, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCompleted({ key: requestKey, result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setCompleted({
            key: requestKey,
            result: { error: error instanceof Error ? error.message : 'Metrics could not be loaded.' },
          });
      });
    return () => controller.abort();
  }, [dimension, period, focus, requestKey]);

  const result = completed?.key === requestKey ? completed.result : undefined;
  const loading = result === undefined;
  const response = result !== undefined && 'report' in result ? result.report : undefined;
  const report = response === undefined || isMetricsUnavailable(response) ? undefined : response;
  const error = result !== undefined && 'error' in result ? result.error : '';

  return (
    <div className="@container flex w-full min-w-0 flex-col gap-4" data-testid="metrics-panel" aria-busy={loading}>
      <div className="flex min-w-0 flex-wrap items-end gap-3 rounded-lg border border-doom-border bg-doom-panel p-3">
        <div className="flex flex-col gap-2">
          <span className="text-sm text-doom-dim">Group by</span>
          <Select
            value={dimension}
            onValueChange={(next) => {
              setFocus('');
              setDimension(next as MetricsDimension);
            }}
          >
            <SelectTrigger aria-label="Group metrics by" data-testid="metrics-dimension" className="w-40 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRICS_DIMENSIONS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {DIMENSION_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm text-doom-dim">Period</span>
          <Select value={period} onValueChange={(next) => setPeriod(next as MetricsPeriod)}>
            <SelectTrigger aria-label="Metrics period" data-testid="metrics-period" className="w-40 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRICS_PERIODS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {PERIOD_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="md"
          className="ml-auto"
          onClick={() => setRefreshKey((current) => current + 1)}
          disabled={loading}
          data-testid="metrics-refresh"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </Button>
      </div>
      {loading ? <MetricsLoading /> : null}
      {error === '' ? null : (
        <p
          role="alert"
          className="rounded-lg border border-doom-edge-red bg-doom-tint-red p-4 text-sm text-doom-red"
          data-testid="metrics-error"
        >
          {error} Use Refresh to try again.
        </p>
      )}
      {response !== undefined && isMetricsUnavailable(response) ? <EmptyForReason response={response} /> : null}
      {report === undefined ? null : (
        <>
          <FocusNotice
            requested={focus}
            applied={report.focus}
            dimension={report.dimension}
            onClear={() => setFocus('')}
          />
          <MetricsReportView report={report} onFocus={setFocus} onPeriodChange={setPeriod} />
        </>
      )}
    </div>
  );
}
