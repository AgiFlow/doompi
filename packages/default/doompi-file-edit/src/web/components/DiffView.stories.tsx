/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import type { FileEditsDiffHunk } from '../../types/fileEditsApi';
import { DiffView } from './DiffView';

const NEAR: FileEditsDiffHunk = {
  start: 12,
  rows: [
    { marker: ' ', line: 12, content: 'export function cn(...inputs: ClassValue[]) {' },
    { marker: '-', line: 13, content: '  return twMerge(clsx(inputs));' },
    { marker: '+', line: 13, content: '  const merged = twMerge(clsx(inputs));' },
    { marker: '+', line: 14, content: '  return merged;' },
    { marker: ' ', line: 15, content: '}' },
  ],
};

const FAR: FileEditsDiffHunk = {
  start: 98,
  rows: [
    { marker: ' ', line: 98, content: 'const empty = { items: [], detail: {} };' },
    { marker: '-', line: 99, content: 'export const files = defineStore(empty);' },
    { marker: '+', line: 99, content: 'export const files = defineSessionStore(empty);' },
    { marker: ' ', line: 100, content: '' },
  ],
};

const meta = {
  title: 'Files/DiffView',
  component: DiffView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          two hunks · the gap between them is a rule
        </span>
        <DiffView hunks={[NEAR, FAR]} testId="story-diff" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">one hunk · three-digit gutter</span>
        <DiffView hunks={[FAR]} testId="story-diff-single" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing changed</span>
        <DiffView hunks={[]} testId="story-diff-empty" />
      </div>
    </div>
  ),
};
