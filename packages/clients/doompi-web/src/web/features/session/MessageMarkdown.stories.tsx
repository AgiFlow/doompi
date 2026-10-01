import { Markdown } from '@agimon-ai/doompi-web-components';

import { StoryFrame } from '../../components/Story.fixture.tsx';
import { MessageMarkdown } from './MessageMarkdown.tsx';

const markdown = [
  '# Component review',
  'Readable **emphasis**, _secondary text_, and an inline `src/components/Button.tsx` path.',
  '> Keep the existing behavior while correcting the visual drift.',
  '- Normal and empty states\n- Long labels and narrow layouts',
  '| Component | Status |\n| --- | --- |\n| Button | Reviewed |\n| Dialog | Reviewed |',
  '```tsx\n<Button variant="primary">Continue</Button>\n```',
  '[Open the component](src/components/Button.tsx)',
].join('\n\n');
const meta = { title: 'Web/Session/MessageMarkdown', component: MessageMarkdown, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => (
    <StoryFrame>
      <MessageMarkdown sessionId="story-session" text={markdown} onFileLink={() => () => undefined} />
    </StoryFrame>
  ),
};

const loadImage = async (path: string) => {
  if (path === 'missing.png') throw new Error('Image is outside the session.');
  const url = URL.createObjectURL(
    new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/><path d="M20 70L60 25L100 60L140 20" fill="none" stroke="white" stroke-width="5"/></svg>',
      ],
      { type: 'image/svg+xml' },
    ),
  );
  return { url, dispose: () => URL.revokeObjectURL(url) };
};
export const SessionImages = {
  render: () => (
    <StoryFrame>
      <Markdown
        text={'![Loaded session image](pic.png)\n\n![Unavailable session image](missing.png)'}
        loadImage={loadImage}
      />
    </StoryFrame>
  ),
};
