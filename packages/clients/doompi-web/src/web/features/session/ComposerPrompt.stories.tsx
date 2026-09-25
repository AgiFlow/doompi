import { Button, OptionRow } from '@agimon-ai/doompi-web-components';

import { StoryFrame, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import type { ToolPromptClaim } from '../../lib/toolPrompt.ts';
import { ComposerPrompt } from './ComposerPrompt.tsx';
import { seedConversationStory, storyTool } from './session.fixture.ts';

const claim: ToolPromptClaim = {
  entry: { ...storyTool, running: true },
  dialog: {
    id: 'story-question',
    method: 'select',
    title: 'Which layout should be reviewed first?',
    message: 'The agent is waiting for your answer.',
    options: ['Desktop workspace', 'Mobile workspace'],
    placeholder: '',
    prefill: '',
  },
  prompt: {
    component: ({ dialog, answer, cancel }) => (
      <section className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-bold text-doom-hi">{dialog.title}</h2>
        <p className="text-sm text-doom-dim">{dialog.message}</p>
        <div className="flex flex-col gap-2">
          {dialog.options.map((option) => (
            <OptionRow key={option} onClick={() => answer(option)}>
              {option}
            </OptionRow>
          ))}
        </div>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </section>
    ),
  },
};
const meta = { title: 'Web/Session/ComposerPrompt', component: ComposerPrompt, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => {
    seedConversationStory();
    return (
      <StoryFrame>
        <div className="rounded-lg border border-doom-edge-magenta bg-doom-deep">
          <ComposerPrompt claim={claim} sessionId={STORY_SESSION_ID} />
        </div>
      </StoryFrame>
    );
  },
};
