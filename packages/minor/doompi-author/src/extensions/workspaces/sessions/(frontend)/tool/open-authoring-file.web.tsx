import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { authorFileTab } from '../_components/AuthorDocumentPanel';
import { OpenAuthoringFileToolCard, resultPath } from './_components/OpenAuthoringFileToolCard';

export default defineToolRenderer({
  tools: ['open_authoring_file'],
  message: OpenAuthoringFileToolCard,
  completionTab: ({ result }) => {
    const path = resultPath(result);
    const details = result?.details as { alias?: unknown } | undefined;
    return path === undefined
      ? undefined
      : authorFileTab(path, typeof details?.alias === 'string' ? details.alias : undefined);
  },
});
