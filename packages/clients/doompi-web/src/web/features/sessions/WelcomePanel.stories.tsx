import { StoryFrame } from '../../components/Story.fixture.tsx';
import { WelcomePanel } from './WelcomePanel.tsx';

const meta = { title: 'Web/Sessions/WelcomePanel', component: WelcomePanel, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <StoryFrame className="flex min-h-screen items-center justify-center bg-doom-bg p-6">
      <WelcomePanel />
    </StoryFrame>
  ),
};
