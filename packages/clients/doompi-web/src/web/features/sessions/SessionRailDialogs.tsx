import { useStore } from '@tanstack/react-store';

import { closeNewSession, newSessionStore } from '../../stores/newSessionStore';
import { closeResumeDialog, railDialogStore } from '../../stores/railDialogStore';
import { workspacesStore } from '../../stores/workspacesStore';
import { NewSessionDialog } from './NewSessionDialog';
import { ResumeSessionDialog } from './ResumeSessionDialog';

/**
 * The rail's dialogs that call their own APIs. Rendered beside the template, not
 * inside it, so they open even while a drawer template has its rail closed.
 * Adding a workspace is the template's own dialog.
 */
export function SessionRailDialogs() {
  const creating = useStore(newSessionStore, (state) => state);
  const workspacesById = useStore(workspacesStore, (state) => state.byId);
  const resume = useStore(railDialogStore, (state) => state.resume);
  const targetWorkspace = creating.workspaceId === null ? undefined : workspacesById[creating.workspaceId];
  return (
    <>
      {creating.open && targetWorkspace !== undefined ? (
        <NewSessionDialog
          workspaceId={targetWorkspace.id}
          workspaceRoot={targetWorkspace.root}
          onClose={closeNewSession}
        />
      ) : null}
      {resume === null ? null : 'sessionId' in resume ? (
        <ResumeSessionDialog sessionId={resume.sessionId} onClose={closeResumeDialog} />
      ) : (
        <ResumeSessionDialog workspaceId={resume.workspaceId} onClose={closeResumeDialog} />
      )}
    </>
  );
}
