import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { seedConversationStory } from './session.fixture.ts';
import { SessionActivity } from './SessionActivity.tsx';

const meta = { title: 'Web/Session/SessionActivity', component: SessionActivity, tags: ['style-system'] };
export default meta;
function preview(streaming = false, olderHistory = false) {
  seedConversationStory({ streaming, hasNewerHistory: olderHistory });
  return (
    <StoryFrame className="min-h-screen w-80 max-w-full bg-doom-rail p-4">
      <SessionActivity sessionId={STORY_SESSION_ID} onOpenConversation={() => undefined} />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview() };
export const Working = { render: () => preview(true) };
export const OlderHistory = { render: () => preview(false, true) };
