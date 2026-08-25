import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { sessionsStore } from './sessionsStore.ts';

/**
 * Navigation for the focused session, in the shape plugins receive: a tab id
 * opens that plugin tab, null returns to the conversation. A no-op while no
 * session is focused, because there is no page to open a tab on.
 */
export function useOpenTab(): (tabId: string | null) => void {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const navigate = useNavigate();
  return (tabId) => {
    if (activeId === null) return;
    void (tabId === null
      ? navigate({ to: '/session/$sessionId', params: { sessionId: activeId } })
      : navigate({ to: '/session/$sessionId/$tabId', params: { sessionId: activeId, tabId } }));
  };
}
