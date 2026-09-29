import { useState } from 'react';

import { groupIssues, type IssueGroup } from '../../../../types/issueGrouping';
import type { IssuesView, MetricsTool } from '../../../../types/webMetrics';
import { barFraction } from '../_lib/chartScale';

/**
 * What is actually going wrong, ranked by how often.
 *
 * A count of 69 issues tells nobody what to change. The same 69 collapsed into
 * "this spawn failed 20 times, this hook failed 3" is a work list, so the
 * ranked bar is the primary view here and the totals are context beside it.
 *
 * Each bar expands to the incidents behind it, because the row states the
 * problem and the reader still needs the session, model, and timestamps to go
 * and look at one.
 */

function countRows(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort(([, left], [, right]) => right - left);
}

/** A short, human label for a problem; the detail can be a whole command line. */
function titleOf(group: IssueGroup): string {
  if (group.errorType !== null) return group.errorType;
  if (group.tool !== null) return `${group.tool} failed`;
  return group.category;
}

interface IssueRowProps {
  group: IssueGroup;
  max: number;
  tools: readonly MetricsTool[];
}

function IssueRow({ group, max, tools }: IssueRowProps) {
  const [open, setOpen] = useState(false);
  const width = `${(barFraction(group.occurrences, max) * 100).toFixed(2)}%`;
  const calls = tools.find((tool) => tool.name === group.tool)?.calls;

  return (
    <li className="flex flex-col rounded-md border border-doom-border">
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-1 rounded-xs bg-doom-yellow/40"
          style={{ width }}
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid={`metrics-issue-${group.key}`}
          className="relative flex min-h-10 w-full flex-wrap items-start gap-3 rounded-md p-3 text-left text-sm hover:bg-doom-tint-blue focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue"
        >
          <span className="w-8 shrink-0 text-right font-bold text-doom-yellow">{group.occurrences}</span>
          <span className="w-24 shrink-0 break-words font-medium text-doom-hi">{titleOf(group)}</span>
          <span className="min-w-40 flex-1 break-words text-doom-dim">{group.detail}</span>
          {calls === undefined ? null : <span className="shrink-0 text-doom-dim">{calls} token samples</span>}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-1 px-3 py-3 text-sm" data-testid={`metrics-issue-body-${group.key}`}>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-doom-dim">
            <span>category {group.category}</span>
            {group.tool === null ? null : <span>tool {group.tool}</span>}
            {group.errorType === null ? null : <span>error {group.errorType}</span>}
            {group.statusCode === null ? null : <span>status {group.statusCode}</span>}
            {group.agentName === null ? null : <span>agent {group.agentName}</span>}
            {group.model === null ? null : <span>model {group.model}</span>}
            <span>last seen {group.lastSeen}</span>
          </div>
          <span className="break-words text-doom-dim">{group.detail}</span>
          <ul className="flex flex-col gap-1 text-xs text-doom-dim">
            {group.members.map((member, index) => (
              <li key={`${member.timestamp}-${String(index)}`} className="flex flex-wrap gap-x-2">
                <span>{member.timestamp}</span>
                <span>{member.level}</span>
                <span>
                  {member.occurrenceCount}
                  {'\u00d7'}
                </span>
                <span className="min-w-0 truncate">{member.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

export interface IssuesDetailProps {
  /** Comparable metrics count, omitted when issue analysis has a broader filter. */
  summaryCount?: number;
  view: IssuesView;
  /** Token-attributed tool calls provide context, not a failure-rate denominator. */
  tools: readonly MetricsTool[];
}

export function IssuesDetail({ view, tools, summaryCount }: IssuesDetailProps) {
  const groups = groupIssues(view.samples);
  const max = groups[0]?.occurrences ?? 0;
  const callsByTool = new Map(tools.map((tool) => [tool.name, tool.calls]));

  return (
    <div className="flex flex-col gap-3">
      {summaryCount !== undefined && summaryCount !== view.totalIssues ? (
        <p
          className="rounded-md border border-doom-edge-yellow bg-doom-tint-yellow p-3 text-sm leading-relaxed text-doom-yellow"
          role="status"
          data-testid="metrics-issue-count-mismatch"
        >
          The summary reports {summaryCount} {summaryCount === 1 ? 'issue' : 'issues'}; incident analysis returned{' '}
          {view.totalIssues}. The counts differ, so these details should not be treated as a complete explanation of the
          summary.
        </p>
      ) : null}
      <span className="text-xs text-doom-dim">
        <span className="text-doom-hi">{view.totalIssues}</span> occurrences of{' '}
        <span className="text-doom-hi">{groups.length}</span> distinct problems in the returned samples, most frequent
        first
      </span>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-doom-border p-4 text-sm text-doom-dim">
          {view.totalIssues === 0
            ? 'No issues were detected in the returned analysis. This does not establish coverage of unrecorded activity.'
            : 'The analysis counted issues but returned no incident samples.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="metrics-issue-groups">
          {groups.map((group) => (
            <IssueRow key={group.key} group={group} max={max} tools={tools} />
          ))}
        </ul>
      )}

      {Object.keys(view.byTool).length === 0 ? null : (
        <div className="flex flex-col gap-2 overflow-x-auto">
          <h4 className="text-sm font-semibold text-doom-hi">Failures by tool</h4>
          <table className="w-full text-sm" data-testid="metrics-issues-tools">
            <thead>
              <tr className="text-xs text-doom-dim">
                <th scope="col" className="py-2 text-left font-normal">
                  Tool
                </th>
                <th scope="col" className="text-right font-normal">
                  Failures
                </th>
                <th scope="col" className="text-right font-normal">
                  Attribution context
                </th>
              </tr>
            </thead>
            <tbody>
              {countRows(view.byTool).map(([name, failures]) => {
                const calls = callsByTool.get(name);
                return (
                  <tr key={name} className="border-b border-doom-border/40">
                    <td className="min-w-0 break-all py-2 text-doom-dim">{name}</td>
                    <td className="w-16 py-2 text-right text-doom-red">{failures}</td>
                    <td className="w-28 py-2 text-right text-doom-faint">
                      {/* These samples need not cover the calls that failed. */}
                      {calls === undefined ? 'no token samples' : `${String(calls)} token samples`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-doom-dim">
        <span className="text-xs font-bold text-doom-dim">by category</span>
        {countRows(view.byCategory).map(([name, count]) => (
          <span key={name}>
            {name} <span className="text-doom-hi">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
