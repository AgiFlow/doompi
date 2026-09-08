/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Label } from './Label.tsx';
import { Checkbox } from './Checkbox.tsx';

const meta = {
  title: 'Components/Label',
  component: Label,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">default</span>
        <Label htmlFor="story-label-name">Session name</Label>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">wrapping a control</span>
        <Label>
          <Checkbox checked aria-label="Stream tokens" />
          Stream tokens
        </Label>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">disabled control</span>
        <div className="flex items-center gap-1.5">
          <Label htmlFor="story-label-disabled">Notify on finish</Label>
          <Checkbox id="story-label-disabled" disabled checked={false} />
        </div>
      </div>
    </div>
  ),
};
