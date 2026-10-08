import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { AgentLockPanel } from './AgentLockPanel.tsx';
import { seedConversationStory } from './session.fixture.ts';

const meta = { title: 'Web/Session/AgentLockPanel', component: AgentLockPanel, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => {
    seedConversationStory();
    return (
      <StoryFrame>
        <AgentLockPanel sessionId={STORY_SESSION_ID} />
      </StoryFrame>
    );
  },
};
