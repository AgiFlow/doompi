/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The section reads its rows out of one
 * session status string, so each variant is a different value for that key.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { LOOP_VIEW_STATUS_KEY } from '../../types/loopView.ts';
import { LoopsActivitySection } from './LoopsActivitySection.tsx';

const LOOPS = JSON.stringify([
  { instanceId: 'loop-1', label: 'nightly digest', detail: 'every 30m · next in 12m', state: 'running' },
  { instanceId: 'loop-2', label: 'inbox sweep', detail: 'waiting for first tick', state: 'starting' },
  { instanceId: 'loop-3', label: 'release watch', detail: 'draining current run', state: 'stopping' },
]);

const props = (raw: string, sessionId: string | null = 's1') =>
  slotPropsFixture({ sessionId, statuses: { [LOOP_VIEW_STATUS_KEY]: raw } }).props;

const meta = {
  title: 'Loop/LoopsActivitySection',
  component: LoopsActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-72 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">active loops</span>
        <LoopsActivitySection {...props(LOOPS)} />
      </div>

      <div className="flex w-72 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">malformed status</span>
        <LoopsActivitySection {...props('not json')} />
      </div>

      <div className="flex w-72 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no focused session · manage off</span>
        <LoopsActivitySection {...props(LOOPS, null)} />
      </div>
    </div>
  ),
};
