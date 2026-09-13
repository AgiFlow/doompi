/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Separator } from './Separator';

const meta = {
  title: 'Components/Separator',
  component: Separator,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">horizontal</span>
        <div className="flex w-64 flex-col gap-2 text-xs">
          <span>above</span>
          <Separator />
          <span>below</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">vertical</span>
        <div className="flex h-5 items-center gap-3 text-xs">
          <span>left</span>
          <Separator orientation="vertical" />
          <span>middle</span>
          <Separator orientation="vertical" />
          <span>right</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">semantic</span>
        <div className="flex w-64 flex-col gap-2 text-xs">
          <span>keeps its separator role</span>
          <Separator decorative={false} />
          <span>instead of being hidden</span>
        </div>
      </div>
    </div>
  ),
};
