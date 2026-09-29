import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { MetricsGroup } from '../../../../../types/webMetrics';
import { barFraction, formatTokens, seriesMax } from '../../_lib/chartScale';

const PREVIEW_GROUPS = 5;

interface GroupBarsProps {
  groups: readonly MetricsGroup[];
  totalTokens?: number;
  focus?: string;
  onFocus?: (key: string) => void;
}

/** Rank recorded consumers; an unknown attribution is not a selectable model. */
export function GroupBars({ groups, totalTokens, focus, onFocus }: GroupBarsProps) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...groups].sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
  const rows = expanded ? sorted : sorted.slice(0, PREVIEW_GROUPS);
  const max = totalTokens ?? seriesMax(groups.map((group) => group.totalTokens));
  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-doom-border p-5 text-sm text-doom-dim">
          No grouped usage was recorded for this selection.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1" data-testid="metrics-group-bars">
        {rows.map((group) => {
          const selected = focus === group.key;
          const unknown = group.key === 'unknown' || group.key === '';
          const canFocus = onFocus !== undefined && !unknown;
          const percentage = barFraction(group.totalTokens, max) * 100;
          const row = (
            <>
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-all text-left font-medium text-doom-hi" title={group.key}>
                  {unknown ? 'Unattributed' : group.key}
                </span>
                <span
                  className="shrink-0 text-right font-semibold tabular-nums text-doom-hi"
                  title={String(group.totalTokens)}
                >
                  {formatTokens(group.totalTokens)}
                </span>
              </span>
              <span aria-hidden="true" className="mt-2 block h-1.5 overflow-hidden rounded-full bg-doom-border">
                <span
                  className={`block h-full rounded-full ${unknown ? 'bg-doom-yellow' : 'bg-doom-blue'}`}
                  style={{ width: `${percentage}%` }}
                />
              </span>
              <span className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-doom-dim">
                <span>
                  {totalTokens !== undefined && max > 0
                    ? `${percentage.toFixed(1)}% of total`
                    : 'Relative token volume'}
                </span>
                <span className={group.issueCount > 0 || group.failed ? 'text-doom-yellow' : 'text-doom-dim'}>
                  {group.failed ? 'Failed · ' : ''}
                  {formatTokens(group.issueCount)} {group.issueCount === 1 ? 'issue' : 'issues'}
                </span>
              </span>
            </>
          );
          return (
            <li key={group.key}>
              {canFocus ? (
                <button
                  type="button"
                  onClick={() => onFocus?.(selected ? '' : group.key)}
                  aria-pressed={selected}
                  aria-label={`Filter to ${group.key}`}
                  data-testid={`metrics-group-${group.key}`}
                  className={`block w-full rounded-md p-3 text-sm hover:bg-doom-tint-blue focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue ${selected ? 'bg-doom-tint-blue' : ''}`}
                >
                  {row}
                </button>
              ) : (
                <div className="rounded-md p-3 text-sm">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      {groups.length > PREVIEW_GROUPS ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Show top 5' : `Show all ${groups.length} returned groups`}
        </Button>
      ) : null}
    </div>
  );
}
