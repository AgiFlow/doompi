/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * The control owns its own clipboard call, so it takes no callback: rendered
 * and never clicked, nothing reaches `navigator.clipboard`.
 */
import { CopyButton } from './CopyButton';

const meta = {
  title: 'Components/CopyButton',
  component: CopyButton,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">default</span>
        <CopyButton text="packages/core/doompi-web-components/src/components/CopyButton.tsx" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">beside the text it copies</span>
        <div className="flex items-center gap-2 rounded-md border border-doom-border bg-doom-deep px-2 py-1">
          <span className="truncate font-mono text-sm text-doom-text">sk-doom-0000-1111-2222</span>
          <CopyButton text="sk-doom-0000-1111-2222" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">at full opacity</span>
        <CopyButton text="pnpm nx run doompi-web-components:test" className="opacity-100" />
      </div>
    </div>
  ),
};
