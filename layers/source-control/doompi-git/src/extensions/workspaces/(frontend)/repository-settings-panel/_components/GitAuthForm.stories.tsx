/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. Each state is the view the server would send.
 */
import type { GitAuthView } from '../../../../../types/gitAuth';
import { GitAuthForm } from './GitAuthForm';

const noop = (): void => undefined;

const STATES: { label: string; saved: GitAuthView; saving?: boolean; saveError?: string; savedNotice?: boolean }[] = [
  { label: "nothing set · this machine's git", saved: { method: 'none' } },
  { label: 'ssh · key path', saved: { method: 'ssh', ssh: { keyPath: '~/.ssh/id_ed25519' } } },
  {
    label: 'https · token saved, just saved',
    saved: { method: 'https', https: { host: 'github.com', username: 'vngo', hasToken: true } },
    savedNotice: true,
  },
  {
    label: 'https · no token yet',
    saved: { method: 'https', https: { host: 'github.com', username: 'vngo', hasToken: false } },
  },
  {
    label: 'https · save refused',
    saved: { method: 'https', https: { host: 'github.com', username: 'vngo', hasToken: true } },
    saveError: 'Confirm with your passkey to change credentials from this device.',
  },
];

const meta = {
  title: 'Git/GitAuthForm',
  component: GitAuthForm,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-8 bg-doom-bg p-6">
      {STATES.map((state) => (
        <div key={state.label} className="flex w-[760px] flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">{state.label}</span>
          <GitAuthForm
            saved={state.saved}
            saving={state.saving ?? false}
            savedNotice={state.savedNotice ?? false}
            onSave={noop}
            {...(state.saveError === undefined ? {} : { saveError: state.saveError })}
          />
        </div>
      ))}
    </div>
  ),
};
