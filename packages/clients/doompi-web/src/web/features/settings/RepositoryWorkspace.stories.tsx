import { StoryFrame } from '../../components/Story.fixture.tsx';
import { settingsSection } from '../../lib/settingsSections.ts';
import { RepositoryWorkspace } from './RepositoryWorkspace.tsx';
import { seedSettingsStory } from './settings.fixture.ts';

const meta = { title: 'Web/RepositoryWorkspace', component: RepositoryWorkspace, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedSettingsStory();
    return (
      <StoryFrame>
        <RepositoryWorkspace current={settingsSection('repositories')!} initialRepositoryId="story-workspace" />
      </StoryFrame>
    );
  },
};

export const NoRepositories = {
  render: () => {
    seedSettingsStory({ 'GET /api/settings/repositories': { repositories: [] } });
    return (
      <StoryFrame>
        <RepositoryWorkspace current={settingsSection('repositories')!} />
      </StoryFrame>
    );
  },
};
