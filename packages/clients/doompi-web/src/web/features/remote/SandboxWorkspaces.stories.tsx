import { seedRemoteStory } from '../../components/Remote.fixture.tsx';
import { StoryFrame } from '../../components/Story.fixture.tsx';
import { SandboxWorkspaces } from './SandboxWorkspaces.tsx';

const meta = { title: 'Web/Remote/SandboxWorkspaces', component: SandboxWorkspaces, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedRemoteStory();
    return (
      <StoryFrame>
        <SandboxWorkspaces
          workspaces={[
            '/workspace/doompi',
            '/workspace/a-very-long-repository-directory/with-a-descriptive-project-name',
          ]}
        />
      </StoryFrame>
    );
  },
};
export const Empty = {
  render: () => {
    seedRemoteStory();
    return (
      <StoryFrame>
        <SandboxWorkspaces workspaces={[]} />
      </StoryFrame>
    );
  },
};
