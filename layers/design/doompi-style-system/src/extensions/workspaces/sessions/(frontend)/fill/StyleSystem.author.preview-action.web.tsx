import { defineFill } from '@agimon-ai/doompi-core/web';

import { storyPreviewTab } from '../_components/StoryPreviewLauncher';
import { StoryPreviewPanel } from '../_components/StoryPreviewPanel';

export default defineFill({
  slot: 'author.preview-action',
  id: 'style-system',
  data: {
    version: 1 as const,
    label: 'Preview',
    detail: 'Build, inspect, refresh, and send source-targeted visual feedback.',
    supportsSource: (source: { kind?: string }) => source.kind === 'story-preview',
    embeddedPanel: StoryPreviewPanel,
    createTab: ({ source }: { source?: { path: string; hasUnsavedChanges: boolean } }) =>
      storyPreviewTab(source === undefined ? undefined : { source }),
  },
});
