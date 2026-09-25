import { StoryFrame } from '../../components/Story.fixture.tsx';
import { RemoteControlSettings } from './RemoteControlSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/RemoteControlSettings', component: RemoteControlSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <RemoteControlSettings />
      </StoryFrame>
    );
  },
};
