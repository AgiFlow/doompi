/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import type { FilesItemView } from '../../types/webFiles.ts';
import { FileActivityRow, FilesBrowser } from './FilesBrowser.tsx';

const NOW = Date.parse('2024-05-04T10:00:00Z');

function item(relPath: string, overrides: Partial<FilesItemView> = {}): FilesItemView {
  return {
    path: `/Users/dev/project/${relPath}`,
    relPath,
    tool: 'edit',
    at: NOW,
    count: 1,
    diffable: true,
    ...overrides,
  };
}

/** A file found by comparing the tree around a bash call: openable, but never diffable. */
const SCANNED = item('dist/index.js', { tool: 'bash', diffable: false });

/** Several directories, a repeat, and the scan-found file, newest change first. */
const ITEMS: FilesItemView[] = [
  item('src/web/components/FilePanel.tsx', { count: 4 }),
  item('src/web/components/DiffView.tsx', { tool: 'write' }),
  item('src/web/lib/fileView.ts', { count: 2 }),
  item('src/types/fileEditsApi.ts'),
  item('tests/unit/fileView.test.ts', { tool: 'user' }),
  SCANNED,
  item('README.md'),
];

const noop = (): void => {};

const meta = {
  title: 'Files/FilesBrowser',
  component: FilesBrowser,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex min-h-screen flex-col gap-6 bg-doom-bg p-6">
      <div className="flex max-w-md flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">activity rows · the dock's own list</span>
        <div className="flex flex-col gap-0.5">
          {ITEMS.slice(0, 4).map((entry) => (
            <FileActivityRow key={entry.path} item={entry} onOpen={noop} />
          ))}
          <FileActivityRow item={SCANNED} onOpen={noop} />
        </div>
      </div>

      <span className="max-w-md text-2xs text-doom-dim uppercase tracking-widest">
        drawer · grouped by path, newest change marked, pinned to the right edge
      </span>

      <FilesBrowser items={ITEMS} onClose={noop} onOpen={noop} />
    </div>
  ),
};
