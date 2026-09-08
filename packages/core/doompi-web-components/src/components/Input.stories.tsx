/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Input } from './Input.tsx';

const VARIANTS = ['default', 'bare'] as const;
const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const meta = {
  title: 'Components/Input',
  component: Input,
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
              <Input variant={variant} size={size} defaultValue={`${variant} ${size}`} className="w-64" />
            </div>
          ))}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state placeholder</span>
        <Input placeholder="search sessions" className="w-64" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state invalid</span>
        <Input aria-invalid defaultValue="not a path" className="w-64" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state disabled</span>
        <Input disabled defaultValue="locked while the run is live" className="w-64" />
      </div>
    </div>
  ),
};
