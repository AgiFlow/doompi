/*
 * Story fixtures are plain CSF objects rather than `Meta`/`StoryObj` from
 * Storybook: the renderer parses these files statically and mounts the exported
 * `render`, so no Storybook runtime is installed and importing its types would
 * add a dependency nothing here needs.
 *
 * `Playground` is the name the DoomPi style-system extension renders by default
 * when a story file is written or edited.
 */
import { Badge } from './Badge';
import { CHIP_TONES } from '../types/tone';

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const meta = {
  title: 'Components/Badge',
  component: Badge,
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
            {CHIP_TONES.map((tone) => (
              <Badge key={tone} tone={tone} size={size}>
                {tone}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};
