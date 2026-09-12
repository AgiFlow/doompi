/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { StatusBadge } from './StatusBadge';
import { STATUS_TONES } from '../types/tone';

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const meta = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">size {size}</span>
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_TONES.map((tone) => (
              <StatusBadge key={tone} tone={tone} size={size}>
                {tone}
              </StatusBadge>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
