/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The browser takes everything as props, so
 * each state is data.
 */
import type { ReactNode } from 'react';

import type { GitReviewFileEntry } from '../../../../../types/gitReview';
import { GitReviewBrowser } from './GitReviewBrowser';

const FILES: GitReviewFileEntry[] = [
  {
    path: 'layers/source-control/doompi-git/src/extensions/workspaces/sessions/(frontend)/_components/GitReviewBrowser.tsx',
    status: 'modified',
    added: 88,
    removed: 62,
  },
  {
    path: 'layers/source-control/doompi-git/src/extensions/workspaces/sessions/(frontend)/_lib/gitReviewTree.ts',
    status: 'untracked',
    added: 61,
    removed: 0,
  },
  {
    path: 'layers/source-control/doompi-git/tests/unit/web/gitReviewTree.test.ts',
    status: 'untracked',
    added: 33,
    removed: 0,
  },
  {
    path: 'layers/template/doompi-template-advanced/src/_components/AdvancedSessionCard.tsx',
    status: 'modified',
    added: 7,
    removed: 1,
  },
  {
    path: 'layers/template/doompi-template-elegant/src/_components/ElegantSessionCard.tsx',
    status: 'modified',
    added: 7,
    removed: 1,
  },
  { path: 'packages/cli/doompi/src/builders/sessionBuilder.ts', status: 'modified', added: 1, removed: 0 },
  { path: 'packages/clients/doompi-web/src/types/plugin.ts', status: 'modified', added: 5, removed: 0 },
  {
    path: 'packages/clients/doompi-web/src/web/stores/usePluginSlotProps.ts',
    status: 'modified',
    added: 13,
    removed: 0,
  },
  { path: 'packages/clients/doompi-web/tests/e2e/activity.spec.ts', status: 'modified', added: 7, removed: 3 },
  { path: 'packages/clients/doompi-web/tests/e2e/workflow.spec.ts', status: 'modified', added: 87, removed: 55 },
  { path: 'packages/core/doompi-core/src/schemas/session.ts', status: 'modified', added: 2, removed: 0 },
  { path: 'packages/core/doompi-core/src/services/serverRuntime/index.ts', status: 'modified', added: 35, removed: 2 },
  { path: 'packages/core/doompi-core/assets/logo.png', status: 'added', added: 0, removed: 0, binary: true },
  { path: 'packages/core/doompi-core/src/services/legacy.ts', status: 'deleted', added: 0, removed: 40 },
  { path: 'README.md', status: 'modified', added: 2, removed: 1 },
];

const ACTIVE = 'packages/clients/doompi-web/src/web/stores/usePluginSlotProps.ts';

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-2xs tracking-widest text-doom-dim uppercase">{label}</span>
      <div className="flex h-160 border border-doom-border-soft bg-doom-bg">{children}</div>
    </div>
  );
}

const meta = {
  title: 'Git/GitReviewBrowser',
  component: GitReviewBrowser,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex gap-6 bg-doom-bg p-6">
      <Frame label="tree · active file · comments">
        <GitReviewBrowser files={FILES} activePath={ACTIVE} commentCounts={{ [ACTIVE]: 2 }} onPick={() => undefined} />
      </Frame>
    </div>
  ),
};
