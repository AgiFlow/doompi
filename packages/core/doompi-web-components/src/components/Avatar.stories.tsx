/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Avatar, AvatarFallback } from './Avatar.tsx';
import { UserIcon } from '../icons/icons.ts';

/** Avatar declares no variants; the size is whatever the caller hands it. */
const SIZES = [
  ['sm', 'h-5 w-5'],
  ['md', 'h-6 w-6'],
  ['lg', 'h-8 w-8'],
] as const;

const meta = {
  title: 'Components/Avatar',
  component: Avatar,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {SIZES.map(([name, size]) => (
        <div key={name} className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">size {name}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Avatar aria-label="Initials" className={size}>
              <AvatarFallback>DP</AvatarFallback>
            </Avatar>
            <Avatar aria-label="Icon" className={size}>
              <AvatarFallback>
                <UserIcon aria-hidden="true" className="h-3 w-3" />
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
      ))}
    </div>
  ),
};
