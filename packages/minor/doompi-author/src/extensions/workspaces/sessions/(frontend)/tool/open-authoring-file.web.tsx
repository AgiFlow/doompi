import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { authorFileTab } from '../_components/AuthorDocumentPanel';
import { OpenAuthoringFileToolCard, resultPath } from './_components/OpenAuthoringFileToolCard';

export default defineToolRenderer({
  tools: ['open_authoring_file'],
  message: OpenAuthoringFileToolCard,
  completionTab: ({ result }) => {
    const path = resultPath(result);
    return path === undefined ? undefined : authorFileTab(path);
  },
});
