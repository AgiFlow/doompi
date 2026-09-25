import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { initialSessionState } from '../../lib/sessionModel.ts';
import { sessionStoreFor } from '../../stores/sessionStore.ts';
import { resetThreads, threadStoreKey } from '../../stores/threadStore.ts';
import { seedConversationStory, storyEntries } from './session.fixture.ts';
import { ThreadView } from './ThreadView.tsx';

const meta = { title: 'Web/Session/ThreadView', component: ThreadView, tags: ['style-system'] };
export default meta;
function preview(empty = false, compact = false) {
  seedConversationStory();
  resetThreads();
  sessionStoreFor(threadStoreKey(STORY_SESSION_ID, 'story-thread')).setState(() => ({
    ...initialSessionState,
    entries: empty ? [] : storyEntries,
  }));
  return (
    <StoryFrame path={`/session/${STORY_SESSION_ID}`} className="flex h-screen min-w-0 flex-col bg-doom-bg">
      <ThreadView
        sessionId={STORY_SESSION_ID}
        threadId="story-thread"
        options={{ compact, limit: compact ? 3 : undefined }}
      />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview() };
export const Compact = { render: () => preview(false, true) };
export const Empty = { render: () => preview(true) };
