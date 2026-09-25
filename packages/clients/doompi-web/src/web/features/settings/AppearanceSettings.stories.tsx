import { StoryFrame } from '../../components/Story.fixture.tsx';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/AppearanceSettings', component: AppearanceSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <AppearanceSettings templateTarget="global" onTemplateTargetChange={() => undefined} />
      </StoryFrame>
    );
  },
};
