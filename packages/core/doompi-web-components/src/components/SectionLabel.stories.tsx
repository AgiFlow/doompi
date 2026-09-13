/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 */
import { SectionLabel } from './SectionLabel';

const HEADINGS = ['sessions', 'activity', 'minor modes'] as const;

const meta = {
  title: 'Components/SectionLabel',
  component: SectionLabel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">default</span>
        <div className="flex flex-wrap items-center gap-6">
          {HEADINGS.map((heading) => (
            <SectionLabel key={heading}>{heading}</SectionLabel>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">heading a section</span>
        <div className="flex flex-col gap-1.5">
          <SectionLabel>sessions</SectionLabel>
          <span className="text-xs text-doom-faint">3 running, 1 idle</span>
        </div>
      </div>
    </div>
  ),
};
