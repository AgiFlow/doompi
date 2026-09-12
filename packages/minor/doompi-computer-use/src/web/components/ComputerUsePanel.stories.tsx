/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The panel reads its own session store rather than props, so each variant is
 * a different session id seeded with the payload the session channel would
 * have delivered. The artifact carries no previewUrl: the renderer has nothing
 * to serve it, and an empty <video> box says less than the rest of the card.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { ComputerUsePanel } from './ComputerUsePanel';
import type { ComputerUseChannelPayload } from '../../types/computerUseApi';
import { computerUse } from '../stores/computerUseStore';

const TARGETS = [
  { windowId: 'w-1', applicationName: 'Reports', windowTitle: 'Reports — Acme' },
  { windowId: 'w-2', applicationName: 'Terminal', windowTitle: 'zsh — 120x40' },
];

const seed = (sessionId: string, payload: ComputerUseChannelPayload): string => {
  computerUse.update(sessionId, () => payload);
  return sessionId;
};

const INACTIVE = seed('cu-inactive', {
  state: { sessionId: 'cu-inactive', revision: 4, wake: 1, phase: 'inactive' },
  targets: TARGETS,
});

const ACTIVE = seed('cu-active', {
  state: { sessionId: 'cu-active', revision: 9, wake: 3, phase: 'active', target: TARGETS[0], durationMs: 300_000 },
  targets: TARGETS,
});

const FAILED = seed('cu-failed', {
  state: {
    sessionId: 'cu-failed',
    revision: 12,
    wake: 5,
    phase: 'failed',
    failure: { code: 'grant_expired', message: 'The activation grant expired before the action ran.' },
    artifact: {
      artifactId: 'rec-8f21',
      status: 'ready',
      downloadUrl: '/api/plugin/computer-use/artifacts/rec-8f21',
      actionCount: 14,
      completedAt: '2024-05-14T14:32:10.000Z',
    },
  },
  targets: TARGETS,
});

const BUSY = seed('cu-busy', {
  state: { sessionId: 'cu-busy', revision: 2, wake: 1, phase: 'inactive' },
  targets: TARGETS,
  busy: true,
});

const slot = (sessionId: string | null) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'ComputerUse/ComputerUsePanel',
  component: ComputerUsePanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">inactive · pick a window</span>
        <ComputerUsePanel {...slot(INACTIVE)} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">active</span>
        <ComputerUsePanel {...slot(ACTIVE)} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed · with a recording</span>
        <ComputerUsePanel {...slot(FAILED)} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">busy in another session</span>
        <ComputerUsePanel {...slot(BUSY)} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no session</span>
        <ComputerUsePanel {...slot(null)} />
      </div>
    </div>
  ),
};
