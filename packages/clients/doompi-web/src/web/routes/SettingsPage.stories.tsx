import { StoryFrame } from '../components/Story.fixture.tsx';
import { seedSettingsStory } from '../features/settings/settings.fixture.ts';
import { SettingsPage } from './SettingsPage.tsx';

const meta = { title: 'Web/SettingsPage', component: SettingsPage, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame path="/settings/appearance" className="h-screen min-w-0 bg-doom-bg">
        <SettingsPage />
      </StoryFrame>
    );
  },
};
