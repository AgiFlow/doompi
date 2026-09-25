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
      <MessageMarkdown text={markdown} onFileLink={() => () => undefined} />
    </StoryFrame>
  ),
};
