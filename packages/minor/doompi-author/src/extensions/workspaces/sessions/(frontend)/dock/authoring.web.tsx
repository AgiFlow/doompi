import { defineDockFace } from '@agimon-ai/doompi-core/web';

import { AuthorPanel } from './_components/AuthorPanel';

export default defineDockFace({
  id: 'authoring',
  label: 'authoring',
  order: 30,
  autoSelect: true,
  panel: AuthorPanel,
  requiredMinorMode: 'author',
  visibility: {
    subscribe() {
      return () => undefined;
    },
    isVisible(sessionId: string | null) {
      return sessionId !== null;
    },
  },
});
