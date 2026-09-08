/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Breadcrumb } from './Breadcrumb.tsx';

const DEEP_PATH = 'packages/core/doompi-web-components/src/components/Breadcrumb.tsx';

const meta = {
  title: 'Components/Breadcrumb',
  component: Breadcrumb,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">single segment</span>
        <Breadcrumb path="README.md" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">short path, nothing collapses</span>
        <Breadcrumb path="src/components/Badge.tsx" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">deep path, default keep 4</span>
        <Breadcrumb path={DEEP_PATH} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">keep 2</span>
        <Breadcrumb path={DEEP_PATH} keep={2} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">keep 6</span>
        <Breadcrumb path={DEEP_PATH} keep={6} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">truncated by a narrow container</span>
        <div className="flex w-48 rounded-md border border-doom-border bg-doom-deep px-2 py-1">
          <Breadcrumb path={DEEP_PATH} />
        </div>
      </div>
    </div>
  ),
};
