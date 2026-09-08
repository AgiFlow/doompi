/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The preview builds its own session file URL
 * and fetches it, so outside a running cockpit only the pending and failed
 * states are reachable; the loaded state needs the session file endpoint.
 */
import { AuthorMediaPreview } from './AuthorMediaPreview.tsx';

const meta = {
  title: 'Author/AuthorMediaPreview',
  component: AuthorMediaPreview,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-full max-w-2xl flex-col gap-2 text-sm text-doom-text">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          fetching the session file · resolves to the failure notice without a host
        </span>
        <AuthorMediaPreview sessionId="s1" path="assets/diagram.png" />
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2 text-sm text-doom-text">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">second path · independent request</span>
        <AuthorMediaPreview sessionId="s1" path="clips/intro.mp4" />
      </div>
    </div>
  ),
};
