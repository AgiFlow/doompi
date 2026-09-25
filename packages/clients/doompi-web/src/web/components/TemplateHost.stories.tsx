import { StoryFrame } from './Story.fixture.tsx';
import { seedTemplateStory, templateProps } from './Template.fixture.tsx';
import { TemplateHost } from './TemplateHost.tsx';

const meta = { title: 'Web/Components/TemplateHost', component: TemplateHost, tags: ['style-system'] };
export default meta;

function preview(phase: 'ready' | 'loading' | 'error', includeTemplate = true) {
  seedTemplateStory(phase, includeTemplate);
  return (
    <StoryFrame className="h-screen bg-doom-bg">
      <TemplateHost {...templateProps} />
    </StoryFrame>
  );
}
export const Playground = { render: () => preview('ready') };
export const Loading = { render: () => preview('loading') };
export const Recovery = { render: () => preview('ready', false) };
export const LoadFailure = { render: () => preview('error', false) };
