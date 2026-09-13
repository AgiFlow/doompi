/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The fixtures are what hashlineBody hands the component: a read is
 * one file's anchored lines, a grep groups matches under each path.
 */
import type { PresentedLine } from '../lib/hashlineView';
import { HashlineLines } from './HashlineLines';

const READ_LINES: readonly PresentedLine[] = [
  {
    type: 'tagged',
    value: { line: 7, content: 'export function cn(...inputs: ClassValue[]): string {', marker: undefined },
  },
  { type: 'tagged', value: { line: 8, content: '  return twMerge(clsx(inputs));', marker: undefined } },
  { type: 'tagged', value: { line: 9, content: '}', marker: undefined } },
  { type: 'plain', text: '[10 of 24 lines shown]' },
];

const GREP_LINES: readonly PresentedLine[] = [
  { type: 'file', path: 'src/components/Badge.tsx' },
  { type: 'tagged', value: { line: 3, content: "import { cn } from '../lib/cn';", marker: 'match' } },
  { type: 'tagged', value: { line: 4, content: '', marker: 'context' } },
  { type: 'file', path: 'src/components/Tabs.tsx' },
  { type: 'tagged', value: { line: 5, content: "import { cn } from '../lib/cn';", marker: 'match' } },
  { type: 'tagged', value: { line: 6, content: '', marker: 'context' } },
];

const meta = {
  title: 'Components/HashlineLines',
  component: HashlineLines,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">read · anchored lines with a notice</span>
        <HashlineLines className="text-sm" lines={READ_LINES} gutter={1} path="src/lib/cn.ts" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">grep · file headings and markers</span>
        <HashlineLines className="text-sm" lines={GREP_LINES} gutter={1} />
      </div>
    </div>
  ),
};
