import { useState } from 'react';
import { groupIssues, type IssueGroup } from '../types/issueGrouping.ts';
import type { IssuesView, MetricsTool } from '../types/webMetrics.ts';
import { barFraction } from './charts/chartScale.ts';

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
    <li className="flex flex-col">
      <div className="relative">
        <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-[2px] bg-doom-red/20" style={{ width }} />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid={`metrics-issue-${group.key}`}
          className="relative flex w-full items-center gap-2 rounded-[2px] px-1 py-[3px] text-left text-[10px] hover:bg-doom-tint focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue"
        >
          <span className="w-8 shrink-0 text-right font-bold text-doom-red">{group.occurrences}</span>
          <span className="w-24 shrink-0 truncate text-doom-hi">{titleOf(group)}</span>
          <span className="min-w-0 flex-1 truncate text-doom-dim">{group.detail}</span>
          {calls === undefined ? null : <span className="shrink-0 text-doom-faint">of {calls} calls</span>}
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-1 px-2 py-2 text-[10px]" data-testid={`metrics-issue-body-${group.key}`}>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-doom-faint">
            <span>category {group.category}</span>
            {group.tool === null ? null : <span>tool {group.tool}</span>}
            {group.errorType === null ? null : <span>error {group.errorType}</span>}
            {group.statusCode === null ? null : <span>status {group.statusCode}</span>}
            {group.agentName === null ? null : <span>agent {group.agentName}</span>}
            {group.model === null ? null : <span>model {group.model}</span>}
            <span>last seen {group.lastSeen}</span>
          </div>
          <span className="break-words text-doom-dim">{group.detail}</span>
          <ul className="flex flex-col gap-[1px] text-[9px] text-doom-faint">
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
  view: IssuesView;
  /** Tool call counts from the report, used as the denominator. */
  tools: readonly MetricsTool[];
}

export function IssuesDetail({ view, tools }: IssuesDetailProps) {
  const groups = groupIssues(view.samples);
  const max = groups[0]?.occurrences ?? 0;
  const callsByTool = new Map(tools.map((tool) => [tool.name, tool.calls]));

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[10px] text-doom-dim">
        <span className="text-doom-hi">{view.totalIssues}</span> occurrences of{' '}
        <span className="text-doom-hi">{groups.length}</span> distinct problems, worst first
      </span>

      {groups.length === 0 ? null : (
        <ul className="flex flex-col gap-[2px]" data-testid="metrics-issue-groups">
          {groups.map((group) => (
            <IssueRow key={group.key} group={group} max={max} tools={tools} />
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-bold text-doom-faint">failures by tool</span>
        <table className="w-full text-[10px]" data-testid="metrics-issues-tools">
          <tbody>
            {countRows(view.byTool).map(([name, failures]) => {
              const calls = callsByTool.get(name);
              return (
                <tr key={name} className="border-b border-doom-border/40">
                  <td className="min-w-0 truncate py-1 text-doom-dim">{name}</td>
                  <td className="w-16 py-1 text-right text-doom-red">{failures}</td>
                  <td className="w-28 py-1 text-right text-doom-faint">
                    {/* Only tools the report also ranked have a denominator;
                        the two reports scan on their own limits. */}
                    {calls === undefined ? 'of unknown calls' : `of ${String(calls)} calls`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-doom-dim">
        <span className="text-[9px] font-bold text-doom-faint">by category</span>
        {countRows(view.byCategory).map(([name, count]) => (
          <span key={name}>
            {name} <span className="text-doom-hi">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
