import { CONTEXT_TOOL_WARNINGS_STATUS_KEY } from '@agimon-ai/doompi-core/contextApi';

import { STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { StoryFrame, seedStorySession } from '../../components/Story.fixture.tsx';
import { sessionStoreFor } from '../../stores/sessionStore.ts';
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

export const Warnings = {
  render: () => {
    seedContextStory();
    sessionStoreFor(STORY_SESSION_ID).setState((state) => ({
      ...state,
      statuses: {
        ...state.statuses,
        [CONTEXT_TOOL_WARNINGS_STATUS_KEY]: JSON.stringify({
          read: [
            {
              source: 'files/read (tools/list)',
              path: 'properties.path.type',
              message: 'Unsupported schema type. Original schema preserved.',
            },
          ],
        }),
      },
    }));
    return panel();
  },
};
