import { sessionFileUrl } from '../../../types/media.ts';
import { StoryFrame, mockStoryRequests, seedStorySession, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import type { FileMention } from '../../lib/fileMentions.ts';
import { MentionPreviewAsset, MentionPreviews } from './MentionPreviews.tsx';

const source: FileMention = { path: 'src/components/a-long-component-name.stories.tsx', kind: 'file' };
const image: FileMention = { path: 'preview.svg', kind: 'image' };
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="gray"/></svg>';
const meta = { title: 'Web/Session/MentionPreviews', component: MentionPreviews, tags: ['style-system'] };
export default meta;
export const Playground = {
  render: () => {
    seedStorySession();
    mockStoryRequests({
      [`GET ${sessionFileUrl(STORY_SESSION_ID, source.path)}`]: new Response('export const Playground = {};', {
        headers: { 'Content-Type': 'text/plain' },
      }),
      [`GET ${sessionFileUrl(STORY_SESSION_ID, image.path)}`]: new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
    });
    return (
      <StoryFrame>
        <MentionPreviews sessionId={STORY_SESSION_ID} mentions={[image, source]} onFileLink={() => () => undefined} />
      </StoryFrame>
    );
  },
};
export const Unavailable = {
  render: () => {
    seedStorySession();
    mockStoryRequests();
    return (
      <StoryFrame>
        <MentionPreviews sessionId={STORY_SESSION_ID} mentions={[source]} />
      </StoryFrame>
    );
  },
};
export const Download = {
  render: () => (
    <StoryFrame>
      <MentionPreviewAsset
        mention={source}
        asset={{ url: 'data:text/plain,Story%20source', contentType: 'text/plain', dispose: () => undefined }}
      />
    </StoryFrame>
  ),
};
