/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The section reads the session store rather than props, so each variant is a
 * different session id seeded before the render runs.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { FilesItemView } from '../../types/webFiles';
import { FilesActivitySection } from './FilesActivitySection';
import { files } from '../stores/filesStore';

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

const FEW: FilesItemView[] = [
  item('src/web/components/FilePanel.tsx', { count: 4 }),
  item('src/web/lib/fileView.ts', { tool: 'write' }),
  item('dist/index.js', { tool: 'bash', diffable: false }),
];

const MANY: FilesItemView[] = [
  ...FEW,
  item('src/types/fileEditsApi.ts'),
  item('src/web/api/filesApi.ts', { count: 2 }),
  item('tests/unit/fileView.test.ts', { tool: 'user' }),
  item('README.md'),
];

files.update('files-few', (current) => ({ ...current, items: FEW }));
files.update('files-many', (current) => ({ ...current, items: MANY }));

const slot = (sessionId: string) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Files/FilesActivitySection',
  component: FilesActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-md flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing changed yet</span>
        <FilesActivitySection {...slot('files-empty')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">three files · one changed by a command</span>
        <FilesActivitySection {...slot('files-few')} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          more than fits · five rows and the show-all link
        </span>
        <FilesActivitySection {...slot('files-many')} />
      </div>
    </div>
  ),
};
