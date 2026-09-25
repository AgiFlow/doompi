import { StoryFrame } from '../components/Story.fixture.tsx';
import { seedSettingsStory } from '../features/settings/settings.fixture.ts';
import { CockpitPage } from './CockpitPage.tsx';

const meta = { title: 'Web/CockpitPage', component: CockpitPage, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame path="/session/story-session" className="h-screen min-w-0 bg-doom-bg">
        <CockpitPage />
      </StoryFrame>
    );
  },
};
