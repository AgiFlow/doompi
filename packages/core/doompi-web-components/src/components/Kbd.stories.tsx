/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Kbd } from './Kbd';

const KEYS = ['SPC', 'C-c', 'g', '⏎', '⌘K'] as const;

const meta = {
  title: 'Components/Kbd',
  component: Kbd,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">keys</span>
        <div className="flex flex-wrap items-center gap-2">
          {KEYS.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">leader hint</span>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-doom-faint">
          <Kbd>SPC</Kbd>
          <Kbd>g</Kbd>
          <Kbd>s</Kbd>
          <span>go to sessions</span>
        </div>
      </div>
    </div>
  ),
};
