/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * Radix only paints the bar once it has measured an overflow, so each frame
 * gets an explicit height and more rows than fit. `type` is set away from the
 * default `hover`, which would leave the bar invisible in a screenshot.
 */
import { ScrollArea } from './ScrollArea';

const meta = {
  title: 'Components/ScrollArea',
  component: ScrollArea,
  tags: ['style-system'],
};

export default meta;

const ROWS = Array.from({ length: 18 }, (_, index) => `run ${String(index + 1).padStart(3, '0')} completed`);

function Rows() {
  return (
    <div className="flex flex-col">
      {ROWS.map((row) => (
        <span key={row} className="border-b border-doom-border-soft px-3 py-1.5 text-sm text-doom-dim last:border-b-0">
          {row}
        </span>
      ))}
    </div>
  );
}

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">type always</span>
          <ScrollArea type="always" className="h-64 w-80 rounded-md border border-doom-border bg-doom-panel">
            <Rows />
          </ScrollArea>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">type auto</span>
          <ScrollArea type="auto" className="h-64 w-80 rounded-md border border-doom-border bg-doom-panel">
            <Rows />
          </ScrollArea>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">no overflow</span>
          <ScrollArea type="always" className="h-64 w-80 rounded-md border border-doom-border bg-doom-panel">
            <span className="block px-3 py-1.5 text-sm text-doom-dim">Content that fits leaves no bar behind.</span>
          </ScrollArea>
        </div>
      </div>
    </div>
  ),
};
