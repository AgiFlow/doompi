import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import { seedConversationStory, storyTool } from './session.fixture.ts';
import { ToolCard } from './ToolCard.tsx';

const meta = { title: 'Web/Session/ToolCard', component: ToolCard, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => {
    seedConversationStory();
    const slotProps = slotPropsFixture().props;
    return (
      <StoryFrame>
        <div className="flex flex-col gap-6">
          <ToolCard entry={storyTool} slotProps={slotProps} statuses={{}} />
          <ToolCard
            entry={{ ...storyTool, id: 'running', toolCallId: 'running', output: '', result: null, running: true }}
            slotProps={slotProps}
            statuses={{}}
          />
          <ToolCard
            entry={{
              ...storyTool,
              id: 'failed',
              toolCallId: 'failed',
              output: 'The component source could not be loaded.',
              isError: true,
            }}
            slotProps={slotProps}
            statuses={{}}
          />
          <ToolCard
            entry={{
              ...storyTool,
              id: 'long',
              toolCallId: 'long',
              output: Array.from(
                { length: 18 },
                (_, index) => `Review item ${index + 1}: component story verified.`,
              ).join('\n'),
            }}
            slotProps={slotProps}
            statuses={{}}
          />
        </div>
      </StoryFrame>
    );
  },
};
