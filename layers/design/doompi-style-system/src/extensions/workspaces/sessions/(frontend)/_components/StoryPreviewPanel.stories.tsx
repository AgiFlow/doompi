import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { storyPreviewTab } from './StoryPreviewLauncher';
import { StoryPreviewPanel } from './StoryPreviewPanel';

const meta = {
  title: 'StyleSystem/StoryPreviewPanel',
  component: StoryPreviewPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="h-screen bg-doom-bg">
      <StoryPreviewPanel {...slotPropsFixture({ sessionId: null }).props} />
    </div>
  ),
};

export const UnsavedSource = {
  render: () => (
    <div className="h-screen bg-doom-bg">
      <StoryPreviewPanel
        {...slotPropsFixture({ sessionId: null }).props}
        source={{
          path: 'packages/core/doompi-web-components/src/components/Button.stories.tsx',
          hasUnsavedChanges: true,
        }}
      />
    </div>
  ),
};

export const LaunchedPreview = {
  render: () => {
    const Panel = storyPreviewTab().panel;
    return (
      <div className="h-screen bg-doom-bg">
        <Panel {...slotPropsFixture({ sessionId: null }).props} />
      </div>
    );
  },
};
