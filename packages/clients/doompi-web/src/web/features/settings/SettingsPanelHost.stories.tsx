import { Button, Panel } from '@agimon-ai/doompi-web-components';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedSettingsStory } from './settings.fixture.ts';
import { SettingsPanelHost } from './SettingsPanelHost.tsx';

const meta = { title: 'Web/SettingsPanelHost', component: SettingsPanelHost, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <SettingsPanelHost
          panel={{
            id: 'story-panel',
            pluginId: 'story-plugin',
            label: 'Plugin diagnostics',
            detail: 'The host owns the heading while the plugin owns its content.',
            component: () => (
              <Panel className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-doom-text">No pending configuration changes.</p>
                <Button size="sm">Refresh diagnostics</Button>
              </Panel>
            ),
          }}
        />
      </StoryFrame>
    );
  },
};
