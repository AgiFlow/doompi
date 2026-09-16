import type { ApiResult } from '@agimon-ai/doompi-core/web';

import { api } from '../../../../../generated/client';
import {
  isMetricsUnavailable,
  METRICS_QUERY_PARAMS,
  type MetricsDimension,
  type MetricsPeriod,
  type MetricsResponse,
  type IssuesResponse,
} from '../../../../types/webMetrics';

/**
 * The page's half of this package's metrics API. The only place the cockpit
 * talks to the hub for metrics, so if the transport ever changes, it changes
 * here alone.
 *
 * These are adapters now, not a transport. The generated client owns the URL
 * and the sealed transport with it, so nothing here spells a route or reaches
 * for `fetch`; a plugin calling `fetch` directly would send plaintext to the
 * tunnel's relay. What stays is this package's own vocabulary: which of the
 * empty states a reader is shown, and which answers are states rather than
 * failures.
 */

const UNREACHABLE = 'The cockpit hub is unreachable.';

/**
 * A hub with no package APIs mounted serves the SPA shell for this route, so
 * the answer is a 200 of HTML rather than an error status. The client parses no
 * JSON out of it and reports no body at all, which is read here as an
 * uninstalled feature, because that is what it is.
 */
const NO_API_DETAIL = 'This cockpit is running a bundle without the log package API, so there are no metrics to read.';

const NO_API: MetricsResponse = { unavailable: 'no-api', detail: NO_API_DETAIL };

export type MetricsResult = { report: MetricsResponse } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A body the hub sent, or which of the two silences it was. */
type Outcome = { body: Record<string, unknown> } | { noApi: true } | { error: string };

/**
 * What the hub's answer means, before either route reads its own shape out of
 * it.
 *
 * `status: 0` is the transport never answering, which covers both a dead hub
 * and a caller that aborted. The client cannot tell those apart, so the signal
 * is asked: an abort is the caller replacing this request, and reporting it
 * would overwrite whatever the replacement renders.
 */
function outcomeOf(result: ApiResult<unknown>, signal?: AbortSignal): Outcome {
  if (result.status === 0) return { error: signal?.aborted === true ? '' : UNREACHABLE };
  const status = `The hub answered ${String(result.status)}.`;
  // No body at all: unparseable and successful is the SPA fallback answering,
  // so the route is not mounted. Unparseable and failed is a hub that broke
  // mid-response, which is only worth the status it carried.
  if (result.data === undefined) return result.ok ? { noApi: true } : { error: status };
  if (!isRecord(result.data)) return { error: 'The hub returned a response the cockpit could not read.' };
  if (!result.ok) return { error: result.error === '' ? status : result.error };
  return { body: result.data };
}

/**
 * Reads one report.
 *
 * A missing sink is not an error here: the route answers it as an
 * `unavailable` body, so the page can name which of the empty states it is in
 * rather than showing one generic failure.
 */
export async function fetchMetrics(
  dimension: MetricsDimension,
  period: MetricsPeriod,
  focus?: string,
  signal?: AbortSignal,
): Promise<MetricsResult> {
  const result = await api.global.metrics({
    query: {
      [METRICS_QUERY_PARAMS.dimension]: dimension,
      [METRICS_QUERY_PARAMS.period]: period,
      [METRICS_QUERY_PARAMS.focus]: focus === '' ? undefined : focus,
    },
    ...(signal === undefined ? {} : { signal }),
  });

  const outcome = outcomeOf(result, signal);
  if ('error' in outcome) return { error: outcome.error };
  if ('noApi' in outcome) return { report: NO_API };

  const report = outcome.body as unknown as MetricsResponse;
  if (!isMetricsUnavailable(report) && !Array.isArray(report.groups)) {
    return { error: 'The hub returned a report the cockpit could not read.' };
  }
  return { report };
}

export type IssuesResult = { issues: IssuesResponse } | { error: string };

/**
 * Reads the detail behind the issue count.
 *
 * Separate call because the hub answers it from a subprocess: folding it into
 * the report would make every refresh wait on the slowest transport.
 */
export async function fetchIssues(focus?: string, signal?: AbortSignal): Promise<IssuesResult> {
  const result = await api.global.issues({
    query: { [METRICS_QUERY_PARAMS.focus]: focus === '' ? undefined : focus },
    ...(signal === undefined ? {} : { signal }),
  });

  const outcome = outcomeOf(result, signal);
  if ('error' in outcome) return { error: outcome.error };
  if ('noApi' in outcome) return { issues: { unavailable: 'no-api', detail: NO_API_DETAIL } };
  return { issues: outcome.body as unknown as IssuesResponse };
}
