import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { MetricsTool } from '../../../../types/webMetrics';
import { formatTokens } from '../_lib/chartScale';

/** The sink attributes a whole turn to its tools. These are samples, not bills. */
export function ToolMetrics({ tools }: { tools: readonly MetricsTool[] }) {
  const [sort, setSort] = useState<'calls' | 'p90TotalTokens'>('p90TotalTokens');
  const rows = [...tools].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name));
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-doom-border bg-doom-panel p-4"
      aria-label="Tool token samples"
    >
      <div>
        <h3 className="text-base font-semibold text-doom-hi">Tool token samples</h3>
        <p className="mt-1 text-sm text-doom-dim">Which tools participate in token-heavy turns?</p>
      </div>
      {rows.length === 0 ? (
        <div
          className="flex flex-1 flex-col justify-center gap-2 rounded-md border border-dashed border-doom-border p-5"
          data-testid="metrics-tools-empty"
        >
          <p className="text-base font-semibold text-doom-hi">No token-attributed tool calls</p>
          <p className="text-sm leading-relaxed text-doom-dim">
            Tool execution logs may exist, but this selection has no samples that connect tools to model usage. This
            does not mean no tools ran.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Rank tool samples by">
            <Button
              size="sm"
              variant={sort === 'p90TotalTokens' ? 'primary' : 'ghost'}
              aria-pressed={sort === 'p90TotalTokens'}
              onClick={() => setSort('p90TotalTokens')}
            >
              P90 turn tokens
            </Button>
            <Button
              size="sm"
              variant={sort === 'calls' ? 'primary' : 'ghost'}
              aria-pressed={sort === 'calls'}
              onClick={() => setSort('calls')}
            >
              Sampled calls
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums" data-testid="metrics-tools">
              <caption className="sr-only">
                Tools ranked by {sort === 'calls' ? 'sampled calls' : '90th percentile whole-turn tokens'}
              </caption>
              <thead>
                <tr className="border-b border-doom-border text-xs text-doom-dim">
                  <th scope="col" className="pb-2 text-left font-normal">
                    Tool
                  </th>
                  <th scope="col" className="pb-2 pl-3 text-right font-normal">
                    Sampled calls
                  </th>
                  <th scope="col" className="pb-2 pl-3 text-right font-normal">
                    P90 turn tokens
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tool) => (
                  <tr key={tool.name} className="border-b border-doom-border/40">
                    <th scope="row" className="max-w-48 break-all py-3 text-left font-normal text-doom-hi">
                      {tool.name}
                    </th>
                    <td className="py-3 pl-3 text-right text-doom-dim">{formatTokens(tool.calls)}</td>
                    <td className="py-3 pl-3 text-right text-doom-blue" title={String(tool.p90TotalTokens)}>
                      {formatTokens(tool.p90TotalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <details className="text-xs leading-relaxed text-doom-dim">
        <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-doom-blue">
          How these samples are counted
        </summary>
        <p className="mt-2">
          This view includes only calls with recorded token attribution; external MCP calls remain in the logs. P90 is
          the 90th percentile of the whole turn, not each tool&apos;s own consumption. Several tools may share a turn,
          so do not add these values together.
        </p>
      </details>
    </section>
  );
}
