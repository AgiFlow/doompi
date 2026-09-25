import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { TopBar } from './TopBar.tsx';

const meta = { title: 'Web/TopBar', component: TopBar, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession();
    return (
      <StoryFrame className="min-h-screen bg-doom-bg">
        <TopBar
          navigationToggle="always"
          activityToggle="always"
          onShowSessions={() => undefined}
          onShowActivity={() => undefined}
        />
      </StoryFrame>
    );
  },
};
