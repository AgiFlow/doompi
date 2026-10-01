/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The rows come from the plugin's own session store seeded per
 * session id, which is exactly where the hub channel puts them.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { gitChanges } from '../../_lib/gitChangesStore';
import { DiffActivitySection } from './DiffActivitySection';

const CHANGES = { branch: 'feat/git', base: 'origin/main', added: 120, removed: 34, files: 6 };

gitChanges.update('s-changes', () => ({
  changes: CHANGES,
  pending: undefined,
  error: undefined,
  errorTarget: undefined,
}));
gitChanges.update('s-clean', () => ({
  changes: { ...CHANGES, added: 0, removed: 0, files: 0 },
  pending: undefined,
  error: undefined,
  errorTarget: undefined,
}));
gitChanges.update('s-syncing', () => ({
  changes: CHANGES,
  pending: 'pushing…',
  error: undefined,
  errorTarget: undefined,
}));

const slot = (sessionId: string | null) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Git/DiffActivitySection',
  component: DiffActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {[
        { label: 'branch vs base', id: 's-changes' },
        { label: 'nothing changed yet', id: 's-clean' },
        { label: 'sync running', id: 's-syncing' },
        { label: 'not reported yet', id: 's-unknown' },
      ].map((state) => (
        <div key={state.id} className="flex w-80 flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">{state.label}</span>
          <DiffActivitySection {...slot(state.id)} />
        </div>
      ))}
    </div>
  ),
};
