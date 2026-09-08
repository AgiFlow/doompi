/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The samples are typed as IssuesView so the grouping this component runs over
 * them is exercised against the real wire shape rather than a loose literal.
 */
import type { IssuesView, MetricsTool } from '../../types/webMetrics.ts';
import { IssuesDetail } from './IssuesDetail.tsx';

const tools: readonly MetricsTool[] = [
  { name: 'bash', calls: 742, p90TotalTokens: 411_200 },
  { name: 'spawn_subagent', calls: 46, p90TotalTokens: 902_100 },
  { name: 'read', calls: 1006, p90TotalTokens: 325_900 },
];

const view: IssuesView = {
  totalIssues: 69,
  uniqueIncidents: 5,
  byCategory: { tool_failure: 44, provider_error: 21, hook_failure: 4 },
  byTool: { bash: 20, spawn_subagent: 21, hook: 3 },
  byErrorType: { overloaded_error: 21, ENOENT: 12 },
  samples: [
    {
      fingerprint: 'tool_failure|pi|bash||pi.tool_result',
      occurrenceCount: 12,
      category: 'tool_failure',
      timestamp: '2025-06-04 08:41',
      level: 'error',
      message: 'pi.tool_result',
      detail: 'pnpm exec nx run doompi-log:test -- --reporter=dot: exited 1',
      tool: 'bash',
      errorType: null,
      agentName: 'ponytail',
      model: 'claude-sonnet-4-5',
      statusCode: null,
    },
    {
      fingerprint: 'tool_failure|pi|bash||pi.tool_result|2',
      occurrenceCount: 8,
      category: 'tool_failure',
      timestamp: '2025-06-04 09:02',
      level: 'error',
      message: 'pi.tool_result',
      detail: 'pnpm exec nx run doompi-log:test -- --reporter=dot: exited 1',
      tool: 'bash',
      errorType: null,
      agentName: 'ponytail',
      model: 'claude-sonnet-4-5',
      statusCode: null,
    },
    {
      fingerprint: 'provider_error|overloaded_error|529',
      occurrenceCount: 21,
      category: 'provider_error',
      timestamp: '2025-06-04 07:55',
      level: 'error',
      message: 'pi.provider_error',
      detail: 'the upstream provider is overloaded; the turn was retried three times',
      tool: null,
      errorType: 'overloaded_error',
      agentName: null,
      model: 'claude-sonnet-4-5',
      statusCode: '529',
    },
    {
      fingerprint: 'tool_failure|pi|spawn_subagent||ENOENT',
      occurrenceCount: 21,
      category: 'tool_failure',
      timestamp: '2025-06-03 22:14',
      level: 'error',
      message: 'pi.tool_result',
      detail: 'ENOENT: bin/runnerHost.mjs could not be found by walking up from dist/src/schemas',
      tool: 'spawn_subagent',
      errorType: 'ENOENT',
      agentName: 'main',
      model: null,
      statusCode: null,
    },
    {
      fingerprint: 'hook_failure|pi|hook||vibe-lint',
      occurrenceCount: 3,
      category: 'hook_failure',
      timestamp: '2025-06-02 11:30',
      level: 'warn',
      message: 'pi.hook_result',
      detail: 'vibe-lint post-edit diagnostics timed out after 30s',
      tool: 'hook',
      errorType: null,
      agentName: null,
      model: null,
      statusCode: null,
    },
  ],
};

/** The sink answered, and nothing went wrong in the window. */
const empty: IssuesView = {
  totalIssues: 0,
  uniqueIncidents: 0,
  byCategory: {},
  byTool: {},
  byErrorType: {},
  samples: [],
};

const meta = {
  title: 'Log/IssuesDetail',
  component: IssuesDetail,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">ranked incidents, worst first</span>
        <IssuesDetail view={view} tools={tools} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing went wrong</span>
        <IssuesDetail view={empty} tools={tools} />
      </div>
    </div>
  ),
};
