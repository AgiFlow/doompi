import { StoryFrame, STORY_WORKSPACE_ID } from '../../components/Story.fixture.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const meta = { title: 'Web/Sessions/NewSessionDialog', component: NewSessionDialog, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <StoryFrame>
      <NewSessionDialog
        workspaceId={STORY_WORKSPACE_ID}
        workspaceRoot="/workspace/doompi/a-long-repository-directory-for-component-review"
        onClose={() => undefined}
      />
    </StoryFrame>
  ),
};
