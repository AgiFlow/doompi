import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedSettingsStory } from './settings.fixture.ts';
import { TemplateSettings } from './TemplateSettings.tsx';

const meta = { title: 'Web/TemplateSettings', component: TemplateSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <TemplateSettings target="global" onTargetChange={() => undefined} />
      </StoryFrame>
    );
  },
};
