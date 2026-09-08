/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Dot } from './Dot.tsx';
import { DOT_TONES } from '../types/tone.ts';

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const meta = {
  title: 'Components/Dot',
  component: Dot,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {SIZES.map((size) => (
        <div key={size} className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">size {size}</span>
          <div className="flex flex-wrap items-center gap-3">
            {DOT_TONES.map((tone) => (
              <Dot key={tone} tone={tone} size={size} />
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">pulse</span>
        <div className="flex flex-wrap items-center gap-3">
          {DOT_TONES.map((tone) => (
            <Dot key={tone} tone={tone} size="lg" pulse />
          ))}
        </div>
      </div>
    </div>
  ),
};
