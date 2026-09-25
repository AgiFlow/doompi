import { StoryFrame } from '../../components/Story.fixture.tsx';
import { RepositorySettings } from './RepositorySettings.tsx';
import { seedSettingsStory, repository } from './settings.fixture.ts';

const meta = { title: 'Web/RepositorySettings', component: RepositorySettings, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <RepositorySettings repository={repository} />
      </StoryFrame>
    );
  },
};

export const NoRepository = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <RepositorySettings repository={null} />
      </StoryFrame>
    );
  },
};
