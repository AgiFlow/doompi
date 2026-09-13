/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Checkbox } from './Checkbox';

/** Every checked state Radix models; passing `checked` with no handler keeps the story static. */
const STATES = [
  ['unchecked', false],
  ['checked', true],
  ['indeterminate', 'indeterminate'],
] as const;

const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state</span>
        <div className="flex flex-wrap items-start gap-4">
          {STATES.map(([name, checked]) => (
            <div key={name} className="flex flex-col items-center gap-2">
              <Checkbox checked={checked} aria-label={name} />
              <span className="text-2xs text-doom-dim uppercase tracking-widest">{name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">disabled</span>
        <div className="flex flex-wrap items-start gap-4">
          {STATES.map(([name, checked]) => (
            <div key={name} className="flex flex-col items-center gap-2">
              <Checkbox disabled checked={checked} aria-label={`${name} disabled`} />
              <span className="text-2xs text-doom-dim uppercase tracking-widest">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};
