import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { StatusBadge } from '@agimon-ai/doompi-web-components';

import { HOST_SLOTS, installWebPlugins, resetWebPlugins } from '../lib/pluginRegistry.ts';
import { PluginSurface } from './PluginSurface.tsx';
import { StoryFrame, seedStorySession, STORY_SESSION_ID } from './Story.fixture.tsx';

const meta = { title: 'Web/Components/PluginSurface', component: PluginSurface, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => {
    seedStorySession();
    resetWebPlugins();
    installWebPlugins([
      defineWebPlugin({
        id: 'story-surface',
        fills: [
          {
            slot: HOST_SLOTS.activity,
            id: 'activity',
            component: ({ sessionId }) => (
              <section className="flex flex-col gap-3 rounded border border-doom-border bg-doom-panel p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-bold text-doom-hi">Plugin activity</h2>
                  <StatusBadge tone="running">running</StatusBadge>
                </div>
                <p className="text-sm text-doom-text">Reviewing component stories for {sessionId}.</p>
              </section>
            ),
          },
        ],
      }),
    ]);
    return (
      <StoryFrame>
        <PluginSurface slot={HOST_SLOTS.activity} sessionId={STORY_SESSION_ID} />
      </StoryFrame>
    );
  },
};
