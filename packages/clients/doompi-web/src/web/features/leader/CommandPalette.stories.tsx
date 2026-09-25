import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { installWebPlugins, resetWebPlugins } from '../../lib/pluginRegistry.ts';
import { paletteStore } from '../../stores/paletteStore.ts';
import { CommandPalette } from './CommandPalette.tsx';

const meta = { title: 'Web/Leader/CommandPalette', component: CommandPalette, tags: ['style-system'] };
export default meta;

function preview(path = '', empty = false) {
  seedStorySession({
    commands: [
      { name: 'review', description: 'Review the current changes and component stories' },
      { name: 'status', description: 'Show the active session status' },
    ],
  });
  resetWebPlugins();
  installWebPlugins(
    empty
      ? []
      : [
          defineWebPlugin({
            id: 'story-commands',
            leaderBindings: [
              {
                id: 'review',
                path: [
                  { key: 'r', label: 'review' },
                  { key: 'c', label: 'components' },
                ],
                command: 'review',
              },
              {
                id: 'status',
                path: [
                  { key: 'r', label: 'review' },
                  { key: 's', label: 'session status' },
                ],
                command: 'status',
              },
              { id: 'notes', path: [{ key: 'n', label: 'session notes' }], run: () => undefined },
            ],
            paletteCommands: [
              {
                id: 'story-preview',
                title: 'Open component preview',
                description: 'Inspect the current story',
                run: () => undefined,
              },
            ],
          }),
        ],
  );
  paletteStore.setState(() => ({ open: true, path }));
  return (
    <StoryFrame>
      <CommandPalette />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview() };
export const Nested = { render: () => preview('r') };
export const Empty = { render: () => preview('', true) };
