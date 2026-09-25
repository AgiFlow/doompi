import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { RefusedCard } from './RefusedCard.tsx';

const meta = { title: 'Web/Connection/RefusedCard', component: RefusedCard, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession({}, { attach: 'refused', reason: 'another_browser_is_attached' });
    return (
      <StoryFrame>
        <RefusedCard />
      </StoryFrame>
    );
  },
};
