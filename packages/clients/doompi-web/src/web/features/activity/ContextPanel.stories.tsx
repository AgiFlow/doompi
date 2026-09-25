import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { seedContextStory } from './context.fixture.ts';
import { ContextPanel } from './ContextPanel.tsx';

const meta = { title: 'Web/Activity/ContextPanel', component: ContextPanel, tags: ['style-system'] };
export default meta;

function panel() {
  return (
    <StoryFrame className="flex h-screen w-80 max-w-full bg-doom-rail">
      <ContextPanel />
    </StoryFrame>
  );
}
export const Playground = {
  render: () => {
    seedContextStory();
    return panel();
  },
};
export const Empty = {
  render: () => {
    seedStorySession();
    return panel();
  },
};
