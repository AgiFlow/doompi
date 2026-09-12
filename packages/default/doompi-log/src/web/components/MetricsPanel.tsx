import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@agimon-ai/doompi-web-components';
import type { SettingsPanelProps } from '@agimon-ai/doompi-core/web';
import { useEffect, useState } from 'react';
import {
  isMetricsUnavailable,
  METRICS_DIMENSIONS,
  METRICS_PERIODS,
  type MetricsDimension,
  type MetricsPeriod,
  type MetricsReport,
  type MetricsResponse,
} from '../../types/webMetrics';
import { EmptyForReason, FocusNotice } from './MetricsNotice';
import { DIMENSION_LABELS } from './MetricsReportView';
import { MetricsReportView } from './MetricsReportView';
import { fetchMetrics } from '../api/metricsApi';

/**
 * The metrics settings page.
 *
 * Reports rather than writes, which is why it is drawn instead of declared as
 * fields. The numbers come from the machine's log sink, so every one of them
 * can be absent for a reason the reader needs told apart: no sink installed,
 * a sink with nothing recorded yet, or a hub that did not answer.
 *
 * Tables here, charts next. The data path is worth proving before the drawing
 * code is layered on it.
 */

export function MetricsPanel(_props: SettingsPanelProps) {
  const [dimension, setDimension] = useState<MetricsDimension>('model');
  const [period, setPeriod] = useState<MetricsPeriod>('week');
  const [focus, setFocus] = useState('');
  const [response, setResponse] = useState<MetricsResponse | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchMetrics(dimension, period, focus, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if ('error' in result) {
        // An empty message is an aborted request, which the next effect replaces.
        if (result.error !== '') setError(result.error);
      } else {
        setError('');
        setResponse(result.report);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [dimension, period, focus]);

  const report: MetricsReport | undefined =
    response === undefined || isMetricsUnavailable(response) ? undefined : response;

  return (
    <div className="flex flex-col gap-3" data-testid="metrics-panel">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          value={dimension}
          onValueChange={(next) => {
            setFocus('');
            setDimension(next as MetricsDimension);
          }}
        >
          <SelectTrigger data-testid="metrics-dimension" className="w-[140px] text-xs">
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
        <Select value={period} onValueChange={(next) => setPeriod(next as MetricsPeriod)}>
          <SelectTrigger data-testid="metrics-period" className="w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRICS_PERIODS.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {candidate}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {loading ? <Spinner /> : null}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-2xs"
          onClick={() => setPeriod((current) => current)}
          disabled={loading}
        >
          refresh
        </Button>
      </div>

      {error === '' ? null : (
        <span className="text-xs text-doom-red" data-testid="metrics-error">
          {error}
        </span>
      )}

      {response !== undefined && isMetricsUnavailable(response) ? <EmptyForReason response={response} /> : null}

      {report === undefined ? null : (
        <FocusNotice requested={focus} applied={report.focus} dimension={dimension} onClear={() => setFocus('')} />
      )}

      {report === undefined ? null : <MetricsReportView report={report} onFocus={setFocus} />}
    </div>
  );
}
