/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Button } from './Button';

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;
const VARIANTS = ['outline', 'primary', 'ghost', 'danger', 'danger-outline', 'success', 'link'] as const;

const meta = {
  title: 'Components/Button',
  component: Button,
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
            {VARIANTS.map((variant) => (
              <Button key={variant} variant={variant} size={size}>
                {variant}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">states</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button loading loadingLabel="Working">
            loading
          </Button>
          <Button disabled>disabled</Button>
          <Button size="icon" aria-label="icon">
            +
          </Button>
        </div>
      </div>
    </div>
  ),
};
