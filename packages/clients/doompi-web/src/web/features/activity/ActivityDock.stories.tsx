import { defineWebPlugin } from '@agimon-ai/doompi-core/web';

import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { installWebPlugins, resetWebPlugins } from '../../lib/pluginRegistry.ts';
import { setDockTab } from '../../stores/uiStore.ts';
import { ActivityDock } from './ActivityDock.tsx';
import { seedContextStory } from './context.fixture.ts';

const meta = { title: 'Web/Activity/ActivityDock', component: ActivityDock, tags: ['style-system'] };
export default meta;

function dock() {
  return (
    <StoryFrame className="flex h-screen bg-doom-bg">
      <ActivityDock onClose={() => undefined} onOpenContent={() => undefined} />
    </StoryFrame>
  );
}

export const Playground = {
  render: () => {
    seedStorySession({ statuses: { 'story-runners': '2 running', 'story-agents': 'idle' } });
    resetWebPlugins();
    installWebPlugins([
      defineWebPlugin({
        id: 'story-activity',
        activityGroups: [
          { name: 'runners', keys: 'r l', statusKey: 'story-runners' },
          { name: 'agents', keys: 'a r', statusKey: 'story-agents' },
        ],
      }),
    ]);
    setDockTab('activity');
    return dock();
  },
};
export const Context = {
  render: () => {
    seedContextStory();
    resetWebPlugins();
    setDockTab('context');
    return dock();
  },
};
export const Empty = {
  render: () => {
    seedStorySession();
    resetWebPlugins();
    setDockTab('activity');
    return dock();
  },
};
