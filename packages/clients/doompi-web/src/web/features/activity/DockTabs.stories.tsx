import { StoryFrame } from '../../components/Story.fixture.tsx';
import { setDockTab } from '../../stores/uiStore.ts';
import { DockTabs } from './DockTabs.tsx';

const meta = { title: 'Web/Activity/DockTabs', component: DockTabs, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    setDockTab('activity');
    return (
      <StoryFrame>
        <DockTabs />
      </StoryFrame>
    );
  },
};
export const Contributed = {
  render: () => {
    setDockTab('notes');
    return (
      <StoryFrame>
        <DockTabs contributed={[{ id: 'notes', label: 'session notes', panel: () => null }]} />
      </StoryFrame>
    );
  },
};
