import type { MetricsGroup } from '../../types/webMetrics.ts';
import { barFraction, formatTokens, seriesMax } from './chartScale.ts';

/**
 * Tokens per group, as horizontal bars.
 *
 * Horizontal rather than vertical because the labels are model names and
 * session hashes, which do not fit under a column. Each row is a button when
 * the caller supplies a handler: clicking one narrows the whole page to that
 * group, which is the drill-down.
 *
 * A row is not a link to a session even when the dimension is 'session'. The
 * identifier is a hash, so there is no session for it to open.
 */

interface GroupBarsProps {
  groups: readonly MetricsGroup[];
  /** The group the page is currently narrowed to, if any. */
  focus?: string;
  onFocus?: (key: string) => void;
}

export function GroupBars({ groups, focus, onFocus }: GroupBarsProps) {
  const max = seriesMax(groups.map((group) => group.totalTokens));

  return (
    <div className="flex flex-col gap-[3px]">
      {/* The two right-hand columns were bare numbers. A row reading "11.0M  12"
          gave no way to know the second figure counted issues. Same widths and
          padding as a row, so the heads sit over their own columns. */}
      <div aria-hidden className="flex items-center gap-2 px-1 text-[9px] text-doom-faint/70">
        <span className="min-w-0 flex-1" />
        <span className="w-14 shrink-0 text-right">tokens</span>
        <span className="w-10 shrink-0 text-right">issues</span>
      </div>
      <ul className="flex flex-col gap-[3px]" data-testid="metrics-group-bars">
        {groups.map((group) => {
          const width = `${(barFraction(group.totalTokens, max) * 100).toFixed(2)}%`;
          const selected = focus === group.key;
          const row = (
            <>
              <span className="min-w-0 flex-1 truncate text-left text-doom-dim">{group.key}</span>
              <span className="w-14 shrink-0 text-right text-doom-hi">{formatTokens(group.totalTokens)}</span>
              <span className="w-10 shrink-0 text-right">
                {group.issueCount === 0 ? (
                  <span className="text-doom-faint/50">ok</span>
                ) : (
                  <span className="text-doom-red">{group.issueCount}</span>
                )}
              </span>
            </>
          );

          return (
            <li key={group.key} className="relative">
              {/* The bar is behind the text rather than beside it, so a long
                model name keeps its full width instead of competing with the
                track for horizontal space. */}
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 rounded-[2px] ${selected ? 'bg-doom-blue/30' : 'bg-doom-blue/15'}`}
                style={{ width }}
              />
              {onFocus === undefined ? (
                <span className="relative flex items-center gap-2 px-1 py-[3px] text-[10px]">{row}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onFocus(selected ? '' : group.key)}
                  aria-pressed={selected}
                  data-testid={`metrics-group-${group.key}`}
                  className="relative flex w-full items-center gap-2 rounded-[2px] px-1 py-[3px] text-[10px] hover:bg-doom-tint focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue"
                >
                  {row}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
