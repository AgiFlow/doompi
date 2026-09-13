/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The panel fetches its own report through the shared sealed transport, which
 * is a plain `fetch` until a tunnel handshake completes. There is no hub behind
 * the renderer, so this file answers the one route the panel reads and lets
 * everything else through; without it the story would only ever show
 * "The cockpit hub is unreachable."
 *
 * ponytail: the stub matches on the path segment rather than parsing the query,
 * so every dimension and period draws the same report. Widen it only if a story
 * needs to compare two selections side by side.
 */
import { LOG_API_BASE_PATH, type MetricsReport } from '../../types/webMetrics';
import { MetricsPanel } from './MetricsPanel';

const report: MetricsReport = {
  generatedAt: '2025-06-04 09:12',
  dimension: 'model',
  period: 'week',
  bucketUnit: 'day',
  transport: 'http',
  totals: {
    totalTokens: 48_240_000,
    inputTokens: 312_400,
    outputTokens: 96_800,
    cachedTokens: 47_610_000,
    reasoningTokens: 12_800,
    groupCount: 3,
    failedGroups: 1,
    issueCount: 23,
  },
  timeline: [
    { label: '2025-05-30', totalTokens: 9_480_000, inputTokens: 62_800, outputTokens: 18_900 },
    { label: '2025-05-31', totalTokens: 1_240_000, inputTokens: 11_200, outputTokens: 3_400 },
    { label: '2025-06-01', totalTokens: 780_000, inputTokens: 7_900, outputTokens: 2_100 },
    { label: '2025-06-02', totalTokens: 12_900_000, inputTokens: 88_300, outputTokens: 27_600 },
    { label: '2025-06-03', totalTokens: 11_460_000, inputTokens: 71_500, outputTokens: 21_300 },
    { label: '2025-06-04', totalTokens: 12_380_000, inputTokens: 70_700, outputTokens: 23_500 },
  ],
  groups: [
    {
      key: 'claude-sonnet-4-5',
      totalTokens: 31_900_000,
      inputTokens: 198_400,
      outputTokens: 61_200,
      issueCount: 14,
      failed: false,
    },
    {
      key: 'gpt-5-codex',
      totalTokens: 12_140_000,
      inputTokens: 79_600,
      outputTokens: 24_800,
      issueCount: 9,
      failed: true,
    },
    {
      key: 'claude-haiku-4-5',
      totalTokens: 4_200_000,
      inputTokens: 34_400,
      outputTokens: 10_800,
      issueCount: 0,
      failed: false,
    },
  ],
  tools: [
    { name: 'read', calls: 1006, p90TotalTokens: 325_900 },
    { name: 'bash', calls: 742, p90TotalTokens: 411_200 },
    { name: 'edit', calls: 388, p90TotalTokens: 298_700 },
  ],
};

const liveFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes(`/api/plugin/${LOG_API_BASE_PATH}/metrics`)) return liveFetch(input, init);
  return Promise.resolve(
    new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

const request = (input: string, init?: RequestInit): Promise<Response> => liveFetch(input, init);

const meta = {
  title: 'Log/MetricsPanel',
  component: MetricsPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a report, with its selects</span>
        <MetricsPanel request={request} requestWithStepUp={request} />
      </div>
    </div>
  ),
};
