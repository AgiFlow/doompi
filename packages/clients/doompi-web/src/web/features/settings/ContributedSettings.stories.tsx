import { StoryFrame } from '../../components/Story.fixture.tsx';
import { ContributedSettings } from './ContributedSettings.tsx';
import { seedSettingsStory, section } from './settings.fixture.ts';

const meta = { title: 'Web/ContributedSettings', component: ContributedSettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <ContributedSettings section={section} scope="global" />
      </StoryFrame>
    );
  },
};

export const Repository = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <ContributedSettings
          section={section}
          scope="repository"
          repoRoot="/workspace/doompi"
          workspaceId="story-workspace"
        />
      </StoryFrame>
    );
  },
};
