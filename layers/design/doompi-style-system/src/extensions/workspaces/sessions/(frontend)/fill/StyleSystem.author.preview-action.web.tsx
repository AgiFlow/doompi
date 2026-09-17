import { defineFill } from '@agimon-ai/doompi-core/web';

import { storyPreviewTab } from '../_components/StoryPreviewLauncher';

export default defineFill({
  slot: 'author.preview-action',
  id: 'style-system',
  data: {
    version: 1 as const,
    label: 'Open story preview',
    detail: 'Build, inspect, refresh, and send source-targeted visual feedback.',
    createTab: ({ source }: { source?: { path: string; hasUnsavedChanges: boolean } }) =>
      storyPreviewTab(source === undefined ? undefined : { source }),
  },
});
