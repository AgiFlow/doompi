import { mockStoryRequests, StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { contextDetails, seedContextStory } from './context.fixture.ts';
import { ContextItemDialog } from './ContextItemDialog.tsx';

const meta = { title: 'Web/Activity/ContextItemDialog', component: ContextItemDialog, tags: ['style-system'] };
export default meta;

function preview(index: number, warnings = false, unavailable = false) {
  seedContextStory();
  if (unavailable) mockStoryRequests();
  const item = contextDetails[index]!;
  return (
    <StoryFrame>
      <ContextItemDialog
        sessionId={STORY_SESSION_ID}
        target={{ itemKind: item.itemKind, name: item.name, owner: 'owner' in item ? item.owner : 'session' }}
        warnings={
          warnings
            ? [
                {
                  source: 'files/read (tools/list)',
                  path: 'properties.path.type',
                  message: 'Unsupported schema type. Original schema preserved.',
                },
              ]
            : undefined
        }
        onClose={() => undefined}
      />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview(0) };
export const Skill = { render: () => preview(1) };
export const SystemPrompt = { render: () => preview(2) };

export const Warnings = { render: () => preview(0, true) };

export const WarningsUnavailable = { render: () => preview(0, true, true) };
