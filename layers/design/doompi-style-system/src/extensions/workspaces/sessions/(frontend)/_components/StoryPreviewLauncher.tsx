import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';

import { StoryPreviewPanel } from './StoryPreviewPanel';

export function storyPreviewTab(): TransientTab {
  return {
    id: 'style-system-story-preview',
    label: 'Story preview',
    panel: StoryPreviewPanel,
    retainComposer: true,
  };
}

export function StoryPreviewLauncher({ sessionId, openTransientTab }: WebPluginSlotProps) {
  return (
    <section className="rounded border border-doom-border-soft p-2" data-testid="style-system-preview-launcher">
      <Button variant="outline" disabled={sessionId === null} onClick={() => openTransientTab(storyPreviewTab())}>
        Open story preview
      </Button>
      <p className="mt-1 text-xs text-doom-faint">Build, inspect, refresh, and send source-targeted visual feedback.</p>
    </section>
  );
}
