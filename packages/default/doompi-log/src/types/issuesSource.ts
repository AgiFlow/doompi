/**
 * The sink's agent-issue analysis, which is a different report from its
 * metrics one and reached a different way.
 *
 * The running daemon exposes only /api/metrics and /api/logs over HTTP, so
 * there is no fast path for this: the CLI subcommand is the only transport.
 * That is why the page fetches it on demand rather than with every report.
 */

export interface IssuesQueryParams {
  /** Narrows to one hashed session, matching the metrics session dimension. */
  sessionId?: string;
  /** How many incidents to return; the counts are unaffected. */
  limit: number;
}

/**
 * One recurring problem, as the sink fingerprints it.
 *
 * The sink already collapses occurrences into incidents, so `occurrenceCount`
 * is how many times this exact problem happened. That number is the reason
 * this report exists: a page that only totals tokens tells nobody what to fix,
 * and "this same failure happened twenty times" does.
 *
 * `detail` is the actionable line. `message` is often a record name such as
 * 'pi.tool_result', while detail carries the spawn that failed or the path
 * that was missing.
 */
export interface AgentIssueSample {
  /** The sink's grouping key. Not unique in its output, so callers re-merge. */
  fingerprint: string;
  occurrenceCount: number;
  category: string;
  timestamp: string;
  level: string;
  message: string;
  detail: string;
  tool: string | null;
  errorType: string | null;
  agentName: string | null;
  model: string | null;
  statusCode: string | null;
}

export interface IssuesReport {
  totalIssues: number;
  /** Distinct incidents after the sink groups by fingerprint. */
  uniqueIncidents: number;
  byCategory: Record<string, number>;
  /** Failures per tool, which the metrics report's tool rows do not carry. */
  byTool: Record<string, number>;
  byErrorType: Record<string, number>;
  samples: AgentIssueSample[];
}

export interface IssuesSource {
  query(params: IssuesQueryParams): Promise<IssuesReport>;
}
