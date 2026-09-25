import { seedStorySession, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import { resetWebPlugins } from '../../lib/pluginRegistry.ts';
import type { QueuedEntry, SessionState, TimelineEntry, ToolEntry } from '../../lib/sessionModel.ts';
import { composerStore, type ComposerSessionState } from '../../stores/composerStore.ts';

export const storyTool: ToolEntry = {
  kind: 'tool',
  id: 'tool-review',
  toolCallId: 'call-review',
  name: 'review_components',
  args: { path: 'src/components' },
  argSummary: 'src/components',
  result: { content: [{ type: 'text', text: 'Checked 12 component stories. No build errors.' }], details: undefined },
  output: 'Checked 12 component stories.\nNo build errors.',
  isError: false,
  running: false,
};

export const storyEntries: TimelineEntry[] = [
  { kind: 'user', id: 'user-review', text: 'Review the component stories and check responsive spacing.' },
  {
    kind: 'assistant',
    id: 'assistant-review',
    text: 'I will check the **shared controls** first, then review each feature panel.',
    thinking: 'The review starts with the shared tokens and interactive sizes.',
    streaming: false,
  },
  storyTool,
  {
    kind: 'assistant',
    id: 'assistant-result',
    text: '### Review results\n\nThe stories cover normal, empty, and error states.\n\n| Area | Result |\n| --- | --- |\n| Layout | Reviewed |\n| Keyboard | Reviewed |\n\n```tsx\n<Button variant="primary">Continue</Button>\n```',
    thinking: '',
    streaming: false,
  },
  { kind: 'settled', id: 'settled-review', tools: 1 },
];

export const queuedEntries: QueuedEntry[] = [
  {
    kind: 'queued',
    id: 'queued-spacing',
    text: 'Check the narrow-screen layout and the longer labels.',
    delivery: 'followUp',
  },
  {
    kind: 'queued',
    id: 'queued-tests',
    text: 'Run the affected tests.\nReport any remaining failures.',
    delivery: 'followUp',
  },
];

export function seedConversationStory(
  state: Partial<SessionState> = {},
  composer: Partial<ComposerSessionState> = {},
): void {
  resetWebPlugins();
  seedStorySession({
    entries: storyEntries,
    profileIdentity: { profile: 'reviewer', name: 'Component reviewer' },
    ...state,
  });
  composerStore.setState(() => ({
    [STORY_SESSION_ID]: {
      draft: '',
      caret: 0,
      dismissedToken: null,
      attachments: [],
      attachmentError: '',
      nextAttachmentId: 0,
      ...composer,
    },
  }));
}
