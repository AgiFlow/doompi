import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { SelectionBar } from './SelectionBar.tsx';

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
