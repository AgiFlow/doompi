import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedSettingsStory } from './settings.fixture.ts';
import { SettingsMenu } from './SettingsMenu.tsx';

const meta = { title: 'Web/SettingsMenu', component: SettingsMenu, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <SettingsMenu active="appearance" workspace="general" />
      </StoryFrame>
    );
  },
};

export const Repository = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <SettingsMenu active="repositories" workspace="repository" repositoryId="story-workspace" />
      </StoryFrame>
    );
  },
};
