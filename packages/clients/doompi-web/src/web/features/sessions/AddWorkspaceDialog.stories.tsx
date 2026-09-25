import { StoryFrame, mockStoryRequests } from '../../components/Story.fixture.tsx';
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx';

const meta = { title: 'Web/Sessions/AddWorkspaceDialog', component: AddWorkspaceDialog, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    mockStoryRequests({
      'GET /api/directories': {
        directories: [
          '/workspace/doompi',
          '/workspace/design-system',
          '/workspace/a-long-project-directory-for-component-review',
        ],
      },
    });
    return (
      <StoryFrame>
        <AddWorkspaceDialog
          onClose={() => undefined}
          suggestedRoots={['/workspace/doompi', '/workspace/design-system']}
        />
      </StoryFrame>
    );
  },
};
export const Empty = {
  render: () => (
    <StoryFrame>
      <AddWorkspaceDialog onClose={() => undefined} />
    </StoryFrame>
  ),
};
