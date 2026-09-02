import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import {
  isMetricsUnavailable,
  issuesUrl,
  metricsUrl,
  type MetricsDimension,
  type MetricsPeriod,
  type MetricsResponse,
  type IssuesResponse,
} from '../types/webMetrics.ts';

/**
 * The page's half of this package's metrics API. The only place the cockpit
 * talks HTTP to the hub for metrics, so if the transport ever changes, it
 * changes here alone.
 *
 * The transport is the shared sealed one rather than bare fetch: a plugin
 * calling fetch directly sends plaintext to the tunnel's relay.
 */

const UNREACHABLE = 'The cockpit hub is unreachable.';

/**
 * A hub with no package APIs mounted serves the SPA shell for this route, so
 * the answer is a 200 of HTML rather than an error status. Reported as an
 * uninstalled feature, which is what it is.
 */
const NO_API_DETAIL = 'This cockpit is running a bundle without the log package API, so there are no metrics to read.';

const NO_API: MetricsResponse = { unavailable: 'no-api', detail: NO_API_DETAIL };

export type MetricsResult = { report: MetricsResponse } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  let response: Response;
  try {
    response = await sealedTransport.fetch(metricsUrl(dimension, period, focus), { signal });
  } catch (error) {
    // An aborted request is the caller replacing it, not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') return { error: '' };
    return { error: UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Unparseable and successful means the SPA fallback answered, so the route
    // is not mounted. Unparseable and failed is a hub that broke mid-response.
    if (response.ok) return { report: NO_API };
    return { error: `The hub answered ${String(response.status)}.` };
  }

  if (!isRecord(body)) return { error: 'The hub returned a response the cockpit could not read.' };
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : `The hub answered ${String(response.status)}.`;
    return { error: detail };
  }

  const report = body as unknown as MetricsResponse;
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
  let response: Response;
  try {
    response = await sealedTransport.fetch(issuesUrl(focus), { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { error: '' };
    return { error: UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) return { issues: { unavailable: 'no-api', detail: NO_API_DETAIL } };
    return { error: `The hub answered ${String(response.status)}.` };
  }

  if (!isRecord(body)) return { error: 'The hub returned a response the cockpit could not read.' };
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : `The hub answered ${String(response.status)}.`;
    return { error: detail };
  }
  return { issues: body as unknown as IssuesResponse };
}
