import { StoryFrame } from '../../components/Story.fixture.tsx';
import { resetWebPlugins } from '../../lib/pluginRegistry.ts';
import { PluginSettings } from './PluginSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/PluginSettings', component: PluginSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <PluginSettings />
      </StoryFrame>
    );
  },
};

export const Empty = {
  render: () => {
    seedSettingsStory();
    resetWebPlugins();
    return (
      <StoryFrame>
        <PluginSettings />
      </StoryFrame>
    );
  },
};
