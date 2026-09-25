import { StoryFrame } from '../../components/Story.fixture.tsx';
import { Composer } from './Composer.tsx';
import { queuedEntries, seedConversationStory } from './session.fixture.ts';

const meta = { title: 'Web/Session/Composer', component: Composer, tags: ['style-system'] };
export default meta;

function frame() {
  return (
    <StoryFrame className="flex min-h-screen flex-col justify-end bg-doom-bg">
      <Composer />
    </StoryFrame>
  );
}
export const Playground = {
  render: () => {
    seedConversationStory({}, { draft: 'Review the component styling and add the missing stories.' });
    return frame();
  },
};
export const Empty = {
  render: () => {
    seedConversationStory();
    return frame();
  },
};
export const Streaming = {
  render: () => {
    seedConversationStory({ streaming: true, entries: queuedEntries }, { draft: 'Also check the mobile layout.' });
    return frame();
  },
};
export const Attachments = {
  render: () => {
    seedConversationStory(
      {},
      {
        draft: 'Review these files.',
        attachments: [
          {
            id: 'story-source',
            kind: 'text',
            name: 'a-long-component-name.stories.tsx',
            content: 'export const Playground = {};',
            size: 29,
          },
          {
            id: 'story-context',
            kind: 'context',
            name: 'Component review notes',
            content: 'Check spacing and semantic colors.',
            size: 34,
            contextKind: 'note',
            contextId: 'story-note',
            source: 'story',
          },
        ],
        attachmentError: 'The last attachment exceeds the size limit. The other files are ready to send.',
      },
    );
    return frame();
  },
};
export const Commands = {
  render: () => {
    seedConversationStory(
      {
        commands: [
          { name: 'review', description: 'Review the current component changes' },
          { name: 'resume', description: 'Resume a saved task' },
        ],
      },
      { draft: '/r', caret: 2 },
    );
    return frame();
  },
};
