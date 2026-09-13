/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { Switch } from './Switch';

const meta = {
  title: 'Components/Switch',
  component: Switch,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state off</span>
        <Switch aria-label="off" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state on</span>
        <Switch aria-label="on" defaultChecked />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state disabled off</span>
        <Switch aria-label="disabled off" disabled />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">state disabled on</span>
        <Switch aria-label="disabled on" defaultChecked disabled />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">beside a label</span>
        {/* Radix renders a button, not a form control, so the caption is a span with the name on the switch. */}
        <span className="flex items-center gap-2 font-mono text-sm text-doom-dim">
          <Switch aria-label="stream tool output" defaultChecked />
          stream tool output
        </span>
      </div>
    </div>
  ),
};
