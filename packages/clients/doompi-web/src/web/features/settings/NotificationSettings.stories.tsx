import { StoryFrame } from '../../components/Story.fixture.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/NotificationSettings', component: NotificationSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <NotificationSettings />
      </StoryFrame>
    );
  },
};
