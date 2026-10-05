import { storyFolders } from '../_lib/styleSystemBrowser';
import { Combobox } from './Combobox';

const meta = { title: 'StyleSystem/Combobox', component: Combobox, tags: ['style-system'] };
export default meta;

const folders = storyFolders(
  [
    'layers/design/doompi-style-system/src/extensions/workspaces/sessions/(frontend)/_components/A.stories.tsx',
    'layers/team/doompi-team/src/extensions/workspaces/sessions/(frontend)/_components/B.stories.tsx',
    'packages/core/doompi-web-components/src/components/Button.stories.tsx',
    'packages/core/doompi-web-components/src/components/Badge.stories.tsx',
    'packages/minor/doompi-author/src/extensions/workspaces/sessions/(frontend)/_components/C.stories.tsx',
    'packages/minor/doompi-author/src/extensions/workspaces/sessions/(frontend)/dock/_components/D.stories.tsx',
  ].map((storyPath) => ({ storyPath, title: storyPath, tags: [], exports: [], shared: false })),
);

export const Playground = {
  render: () => (
    <div className="flex h-[520px] gap-6 bg-doom-bg p-6">
      <Combobox
        label="Folder"
        placeholder="All folders"
        className="w-72"
        defaultOpen
        options={[
          { value: '', label: 'All folders', detail: '6 components' },
          ...folders.map((entry) => ({
            value: entry.path,
            label: entry.label,
            fullLabel: entry.path,
            depth: entry.depth,
            detail: `${entry.count} components`,
          })),
        ]}
        selected={['packages/core/doompi-web-components/src/components']}
        onSelect={() => undefined}
      />
    </div>
  ),
};
