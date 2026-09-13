/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Textarea } from './Textarea';

const VARIANTS = ['default', 'bare'] as const;
const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const meta = {
  title: 'Components/Textarea',
  component: Textarea,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col gap-3">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">variant {variant}</span>
          {SIZES.map((size) => (
            <div key={size} className="flex flex-col gap-1">
              <span className="text-2xs text-doom-dim uppercase tracking-widest">size {size}</span>
              <Textarea
                variant={variant}
                size={size}
                rows={2}
                defaultValue={`${variant} ${size}\nsecond line`}
                className="w-64"
              />
            </div>
          ))}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state placeholder</span>
        <Textarea rows={2} placeholder="ask for something" className="w-64" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state invalid</span>
        <Textarea aria-invalid rows={2} defaultValue="the prompt is empty" className="w-64" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state disabled</span>
        <Textarea disabled rows={2} defaultValue="locked while the run is live" className="w-64" />
      </div>
    </div>
  ),
};
