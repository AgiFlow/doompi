import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { seedConversationStory, storyEntries, storyTool } from './session.fixture.ts';
import { Timeline } from './Timeline.tsx';

const meta = { title: 'Web/Session/Timeline', component: Timeline, tags: ['style-system'] };
export default meta;
function frame() {
  return (
    <StoryFrame path={`/session/${STORY_SESSION_ID}`} className="flex h-screen min-w-0 flex-col bg-doom-bg">
      <Timeline />
    </StoryFrame>
  );
}
export const Playground = {
  render: () => {
    seedConversationStory();
    return frame();
  },
};
export const Streaming = {
  render: () => {
    seedConversationStory({
      streaming: true,
      entries: [
        ...storyEntries.slice(0, 3),
        {
          kind: 'assistant',
          id: 'streaming',
          text: 'The component review is in progress...',
          thinking: 'Checking the remaining variants.',
          streaming: true,
        },
      ],
    });
    return frame();
  },
};
export const ToolGroupAndError = {
  render: () => {
    seedConversationStory({
      entries: [
        storyEntries[0]!,
        storyTool,
        {
          ...storyTool,
          id: 'tool-second',
          toolCallId: 'call-second',
          output: 'The requested file could not be read.',
          isError: true,
        },
        {
          kind: 'notice',
          id: 'notice-error',
          text: 'A required component source was unavailable. The review has paused.',
          tone: 'error',
        },
      ],
    });
    return frame();
  },
};
export const Empty = {
  render: () => {
    seedConversationStory({ entries: [] });
    return frame();
  },
};
