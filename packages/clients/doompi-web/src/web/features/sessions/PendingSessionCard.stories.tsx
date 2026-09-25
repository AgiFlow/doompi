import { StoryFrame, seedStorySession, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { PendingSessionCard } from './PendingSessionCard.tsx';

const meta = { title: 'Web/Sessions/PendingSessionCard', component: PendingSessionCard, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession();
    const parent = sessionsStore.state.byId[STORY_SESSION_ID]!.summary;
    return (
      <StoryFrame className="min-h-screen w-80 max-w-full bg-doom-rail p-3">
        <PendingSessionCard
          parent={parent}
          setup={{
            id: 'story-setup',
            name: 'Review components in an isolated worktree',
            createdAt: '2026-09-01T10:00:00.000Z',
          }}
        />
      </StoryFrame>
    );
  },
};
