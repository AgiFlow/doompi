import { defineDockFace } from '@agimon-ai/doompi-core/web';

import { AuthorPanel } from '../../../../../web/components/AuthorPanel';
import { authorWorkspace } from '../../../../../web/stores/authorWorkspaceStore';

export default defineDockFace({
  id: 'authoring',
  label: 'authoring',
  order: 30,
  autoSelect: true,
  panel: AuthorPanel,
  requiredMinorMode: 'author',
  visibility: {
    subscribe(listener: () => void) {
      const subscription = authorWorkspace.store.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    isVisible(sessionId: string | null) {
      return sessionId !== null && authorWorkspace.store.state.sessions[sessionId]?.focusedDocument !== undefined;
    },
  },
});
