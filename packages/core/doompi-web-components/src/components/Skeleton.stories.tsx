/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Skeleton } from './Skeleton.tsx';

const meta = {
  title: 'Components/Skeleton',
  component: Skeleton,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">text lines</span>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">block</span>
        <Skeleton className="h-16 w-64" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">avatar</span>
        <Skeleton className="h-6 w-6 rounded-full" />
      </div>
    </div>
  ),
};
