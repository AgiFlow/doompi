import type { IssueSample } from './webMetrics.ts';

/**
 * Turning a list of incidents into a ranked list of problems.
 *
 * Pure, and in types/ so both halves may use it: the page ranks, and a test
 * can assert the ranking without a render or a subprocess.
 *
 * Two things the sink's own output needs fixing for. It can emit the same
 * fingerprint more than once, so occurrences have to be re-summed or the same
 * problem appears three times at a third of its real weight. And its ordering
 * is by recency, which buries a problem that happened twenty times under one
 * that happened once a minute ago.
 */

export interface IssueGroup {
  /** Stable identity for a row, unique after merging. */
  key: string;
  /** How many times this exact problem happened. */
  occurrences: number;
  category: string;
  /** The actionable line: the spawn that failed, the path that was missing. */
  detail: string;
  tool: string | null;
  errorType: string | null;
  agentName: string | null;
  model: string | null;
  statusCode: string | null;
  /** Most recent occurrence across the merged incidents. */
  lastSeen: string;
  /** Every incident folded into this row, for the expanded view. */
  members: IssueSample[];
}

/**
 * A key that separates problems a reader would act on separately.
 *
 * The sink's fingerprint is the primary key, but it can be empty, and several
 * distinct bash failures share 'tool_failure|pi|bash||pi.tool_result' because
 * the record name is all they carry. Folding the detail in keeps two different
 * failures apart while still merging repeats of the same one.
 */
export function groupingKey(sample: IssueSample): string {
  const base = sample.fingerprint === '' ? `${sample.category}|${sample.message}` : sample.fingerprint;
  return `${base}|${sample.detail}`;
}

/** Incidents merged by problem and ranked by how often each happened. */
export function groupIssues(samples: readonly IssueSample[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();

  for (const sample of samples) {
    const key = groupingKey(sample);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        occurrences: sample.occurrenceCount,
        category: sample.category,
        detail: sample.detail,
        tool: sample.tool,
        errorType: sample.errorType,
        agentName: sample.agentName,
        model: sample.model,
        statusCode: sample.statusCode,
        lastSeen: sample.timestamp,
        members: [sample],
      });
      continue;
    }
    existing.occurrences += sample.occurrenceCount;
    existing.members.push(sample);
    if (sample.timestamp > existing.lastSeen) existing.lastSeen = sample.timestamp;
    // A merged row keeps whichever identifying field any member supplied, so
    // one incident missing an agent name does not blank it for the group.
    existing.tool ??= sample.tool;
    existing.errorType ??= sample.errorType;
    existing.agentName ??= sample.agentName;
    existing.model ??= sample.model;
    existing.statusCode ??= sample.statusCode;
  }

  return [...groups.values()].sort(
    (left, right) => right.occurrences - left.occurrences || left.detail.localeCompare(right.detail),
  );
}
