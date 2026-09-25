import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { contextDetails, seedContextStory } from './context.fixture.ts';
import { ContextItemDialog } from './ContextItemDialog.tsx';

const meta = { title: 'Web/Activity/ContextItemDialog', component: ContextItemDialog, tags: ['style-system'] };
export default meta;

function preview(index: number) {
  seedContextStory();
  const item = contextDetails[index]!;
  return (
    <StoryFrame>
      <ContextItemDialog
        sessionId={STORY_SESSION_ID}
        target={{ itemKind: item.itemKind, name: item.name, owner: 'owner' in item ? item.owner : 'session' }}
        onClose={() => undefined}
      />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview(0) };
export const Skill = { render: () => preview(1) };
export const SystemPrompt = { render: () => preview(2) };
