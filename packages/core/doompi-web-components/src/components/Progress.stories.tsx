/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Progress } from './Progress';

const VALUES = [0, 25, 50, 75, 100] as const;

const meta = {
  title: 'Components/Progress',
  component: Progress,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {VALUES.map((value) => (
        <div key={value} className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">value {value}</span>
          <Progress value={value} className="w-64" />
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">indeterminate</span>
        <Progress className="w-64" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">full width</span>
        <Progress value={40} />
      </div>
    </div>
  ),
};
