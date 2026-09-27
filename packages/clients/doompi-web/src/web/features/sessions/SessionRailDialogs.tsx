import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { useStore } from '@tanstack/react-store';
import { createElement, type ComponentType } from 'react';

import { HOST_SLOTS, workspaceSlotFills } from '../../lib/pluginRegistry';
import { fetchWithStepUp } from '../../lib/stepUp';
import { closeNewSession, newSessionStore } from '../../stores/newSessionStore';
import { closeResumeDialog, railDialogStore } from '../../stores/railDialogStore';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps';
import { useWebPluginRegistry } from '../../stores/useWebPluginRegistry';
import { workspacesStore } from '../../stores/workspacesStore';
import { NewSessionDialog } from './NewSessionDialog';
import { ResumeSessionDialog } from './ResumeSessionDialog';
import { useNewSessionActions } from './useNewSessionActions';

/** A workspace plugin's replacement for the new-session dialog, handed the host's create helpers. */
function PluginNewSessionDialog({
  component,
  workspaceId,
  workspaceRoot,
}: {
  component: ComponentType<WebPluginSlotProps>;
  workspaceId: string;
  workspaceRoot: string;
}) {
  const props = usePluginSlotProps(null);
  const actions = useNewSessionActions(workspaceId, closeNewSession);
  return createElement(component, {
    ...props,
    newSession: { workspaceId, workspaceRoot, close: closeNewSession, requestWithStepUp: fetchWithStepUp, ...actions },
  });
}

/**
 * The rail's dialogs that call their own APIs. Rendered beside the template, not
 * inside it, so they open even while a drawer template has its rail closed.
 * Adding a workspace is the template's own dialog. A workspace plugin's
 * `new-session` fill stands in for the host's new-session dialog.
 */
export function SessionRailDialogs() {
  useWebPluginRegistry();
  const creating = useStore(newSessionStore, (state) => state);
  const workspacesById = useStore(workspacesStore, (state) => state.byId);
  const resume = useStore(railDialogStore, (state) => state.resume);
  const targetWorkspace = creating.workspaceId === null ? undefined : workspacesById[creating.workspaceId];
  const replacement =
    targetWorkspace === undefined
      ? undefined
      : workspaceSlotFills(targetWorkspace.id, HOST_SLOTS.newSession).find((fill) => fill.component !== undefined);
  return (
    <>
      {creating.open && targetWorkspace !== undefined ? (
        replacement?.component !== undefined ? (
          <PluginNewSessionDialog
            key={`${replacement.pluginId}:${replacement.id}`}
            component={replacement.component}
            workspaceId={targetWorkspace.id}
            workspaceRoot={targetWorkspace.root}
          />
        ) : (
          <NewSessionDialog
            workspaceId={targetWorkspace.id}
            workspaceRoot={targetWorkspace.root}
            onClose={closeNewSession}
          />
        )
      ) : null}
      {resume === null ? null : 'sessionId' in resume ? (
        <ResumeSessionDialog sessionId={resume.sessionId} onClose={closeResumeDialog} />
      ) : (
        <ResumeSessionDialog workspaceId={resume.workspaceId} onClose={closeResumeDialog} />
      )}
    </>
  );
}
