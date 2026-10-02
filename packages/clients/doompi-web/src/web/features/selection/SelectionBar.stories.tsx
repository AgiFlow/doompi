import { Popover, PopoverAnchor } from '@agimon-ai/doompi-web-components';

import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { ModelPopup, SelectionBar } from './SelectionBar.tsx';

const meta = { title: 'Web/SelectionBar', component: SelectionBar, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession({ statuses: { 'doom-major-mode': 'copilot' } });
    return (
      <StoryFrame>
        <SelectionBar />
      </StoryFrame>
    );
  },
};

export const FastPicker = {
  render: () => (
    <StoryFrame>
      <Popover open>
        <PopoverAnchor>
          <span>Model picker</span>
        </PopoverAnchor>
        <ModelPopup
          agent={{
            provider: 'openai-codex',
            model: 'gpt-5.4',
            thinkingLevel: 'high',
            sessionId: 'story',
            sessionName: '',
            messageCount: 0,
            isStreaming: false,
          }}
          models={[]}
          levels={['off', 'high']}
          onClose={() => undefined}
        />
      </Popover>
    </StoryFrame>
  ),
};
