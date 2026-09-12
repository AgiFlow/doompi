/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The panel reads the plan over the session API on mount, and the renderer has
 * no hub behind it, so every view but the error one would be unreachable. The
 * plan route is answered here at module scope, from the same PlanDetailView the
 * route returns; anything else still goes to the page's own fetch.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { PlanPanel } from './PlanPanel';
import { currentUrl, type PlanDetailView } from '../../types/planApi';

const PLAN: PlanDetailView = {
  path: '.doom/plans/story-coverage.md',
  title: 'Cockpit story coverage for plugin packages',
  writtenAt: '2024-05-14T14:32:00.000Z',
  content: [
    '# Cockpit story coverage',
    '',
    'One plain-CSF story beside every plugin component, rendered by the',
    'style-system pipeline rather than a Storybook runtime.',
    '',
    '## Steps',
    '',
    '1. Read each component signature and derive its props from it.',
    '2. Use the contracts package fixtures for slot and tool-message props.',
    '3. Render every story and read the PNG back.',
    '',
    '## Out of scope',
    '',
    '- Component source changes.',
    '- Anything under `package.json` or the workspace configs.',
  ].join('\n'),
  hash: 'b4c1f0a9',
  unavailable: false,
};

const UNAVAILABLE: PlanDetailView = {
  path: '.doom/plans/oversized.md',
  title: 'oversized plan',
  writtenAt: '2024-05-14T09:04:00.000Z',
  content: '',
  hash: '',
  unavailable: true,
  reason: 'this plan is larger than the cockpit will load; open it from the editor instead.',
};

const answers: Readonly<Record<string, PlanDetailView>> = {
  [currentUrl('plan-preview')]: PLAN,
  [currentUrl('plan-unavailable')]: UNAVAILABLE,
};

const pageFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const detail = answers[url];
  if (detail === undefined) return pageFetch(input, init);
  return Promise.resolve(
    new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
};

const slot = (sessionId: string | null) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Plan/PlanPanel',
  component: PlanPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">preview</span>
        <div className="flex h-96 flex-col border border-doom-border">
          <PlanPanel {...slot('plan-preview')} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">plan too large to show</span>
        <div className="flex h-40 flex-col border border-doom-border">
          <PlanPanel {...slot('plan-unavailable')} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">session unreachable</span>
        <div className="flex h-40 flex-col border border-doom-border">
          <PlanPanel {...slot('plan-missing')} />
        </div>
      </div>
    </div>
  ),
};
