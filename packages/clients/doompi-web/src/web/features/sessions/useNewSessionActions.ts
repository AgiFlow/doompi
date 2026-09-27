import { useNavigate } from '@tanstack/react-router';

import { createWorkspaceSession } from '../../lib/hubApi';
import { applySessionUpsert, waitForSession } from '../../stores/sessionsStore';

const NOT_YET_VISIBLE = 'The session was created but has not appeared yet; it will show up in the rail.';

/**
 * The host's ways to finish a new-session dialog: create a plain session in the
 * workspace root, or open one another package created. Both resolve an error
 * message to show, or undefined once the dialog closed and the session is open.
 */
export function useNewSessionActions(workspaceId: string, onClose: () => void) {
  const navigate = useNavigate();

  const openCreated = async (sessionId: string): Promise<string | undefined> => {
    if (!(await waitForSession(sessionId))) return NOT_YET_VISIBLE;
    onClose();
    await navigate({ to: '/session/$sessionId', params: { sessionId } });
    return undefined;
  };

  const createPlain = async (name?: string): Promise<string | undefined> => {
    const outcome = await createWorkspaceSession(workspaceId, { name: name?.trim() || undefined });
    if (!('sessionId' in outcome)) return outcome.error;
    if (outcome.session !== undefined) applySessionUpsert({ session: outcome.session });
    return openCreated(outcome.sessionId);
  };

  return { createPlain, openCreated };
}
