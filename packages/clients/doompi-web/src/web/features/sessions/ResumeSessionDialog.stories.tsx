import type { PiSessionHistoryItem } from '../../../types/hub.ts';
import {
  StoryFrame,
  mockStoryRequests,
  seedStorySession,
  STORY_WORKSPACE_ID,
  STORY_SESSION_ID,
} from '../../components/Story.fixture.tsx';
import { ResumeSessionDialog } from './ResumeSessionDialog.tsx';

const history: PiSessionHistoryItem[] = [
  {
    id: STORY_SESSION_ID,
    name: 'Already running session',
    firstMessage: 'Review the active component stories.',
    messageCount: 12,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
  },
  {
    id: 'saved-review',
    name: 'A saved review with a long descriptive session name',
    firstMessage: 'Check responsive spacing, keyboard navigation, and semantic colors across all component states.',
    messageCount: 32,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
  },
  {
    id: 'unnamed-review',
    firstMessage: 'Continue the visual review',
    messageCount: 4,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
  },
];
const meta = { title: 'Web/Sessions/ResumeSessionDialog', component: ResumeSessionDialog, tags: ['style-system'] };
export default meta;

function preview(sessions: PiSessionHistoryItem[]) {
  seedStorySession();
  mockStoryRequests({ [`GET /api/workspaces/${STORY_WORKSPACE_ID}/history`]: { sessions } });
  return (
    <StoryFrame>
      <ResumeSessionDialog workspaceId={STORY_WORKSPACE_ID} onClose={() => undefined} />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview(history) };
export const Empty = { render: () => preview([]) };
