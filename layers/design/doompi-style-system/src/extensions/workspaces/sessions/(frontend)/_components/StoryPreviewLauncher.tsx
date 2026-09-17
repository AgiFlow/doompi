import type { TransientTab } from '@agimon-ai/doompi-core/web';

import type { StoryPreviewSeed } from '../../../../../types/previewApi';
import { StoryPreviewPanel } from './StoryPreviewPanel';

function sourceKey(path: string): string {
  let hash = 2_166_136_261;
  for (const character of path) hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  return (hash >>> 0).toString(36);
}

export function storyPreviewTab(seed?: StoryPreviewSeed): TransientTab {
  const sourcePath = seed?.source?.path;
  return {
    id: sourcePath === undefined ? 'style-system-story-preview' : `style-system-story-preview-${sourceKey(sourcePath)}`,
    label: 'Story preview',
    panel: (props) => <StoryPreviewPanel {...props} seed={seed} />,
    retainComposer: true,
  };
}
