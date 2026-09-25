import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { DormantPanel } from './DormantPanel.tsx';
import { seedConversationStory } from './session.fixture.ts';

const meta = { title: 'Web/Session/DormantPanel', component: DormantPanel, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => {
    seedConversationStory();
    const current = sessionsStore.state.byId[STORY_SESSION_ID]!;
    return (
      <StoryFrame>
        <DormantPanel meta={{ ...current, summary: { ...current.summary, dormant: true } }} />
      </StoryFrame>
    );
  },
};
