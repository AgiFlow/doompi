/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Spinner } from './Spinner.tsx';

/** Spinner declares no variants; it turns in the current text colour at whatever size it is given. */
const SIZES = [
  ['sm', 'h-3 w-3'],
  ['md', 'h-4 w-4'],
  ['lg', 'h-5 w-5'],
] as const;

const meta = {
  title: 'Components/Spinner',
  component: Spinner,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">size</span>
        <div className="flex flex-wrap items-center gap-4">
          {SIZES.map(([name, size]) => (
            <Spinner key={name} className={size} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">announced</span>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Spinner label="Loading providers" />
          <span>loading providers</span>
        </div>
      </div>
    </div>
  ),
};
