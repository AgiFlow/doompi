import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Sheet, SheetContent, SheetTitle } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';

import { LaunchWorkflowDialog } from '../../_components/LaunchWorkflowDialog';
import { WorkflowCatalogDrawer } from '../../_components/WorkflowCatalogDrawer';
import { catalog, closeCatalog, closeLaunch, openLaunch } from '../../_lib/catalogStore';

/**
 * The workflow catalog and its launch dialog, over whatever the session shows.
 *
 * Every way in (SPC w l, the Activity launcher, a work item's context action)
 * only flips the catalog store, so the surface lives in the host's overlay
 * slot rather than in a tab the reader would have to open first.
 */
export function WorkflowLauncherOverlay({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const state = useStore(catalog.store, (current) => catalog.select(current, sessionId));
  if (sessionId === null) return null;
  const launching = state.workflows.find((workflow) => workflow.path === state.launch);

  return (
    <>
      <Sheet
        open={state.open}
        onOpenChange={(open) => {
          if (!open) closeCatalog(sessionId);
        }}
      >
        <SheetContent side="right" width="md" aria-describedby={undefined} className="border-l-0">
          <SheetTitle className="sr-only">workflow catalog</SheetTitle>
          <div data-testid="workflow-launcher-sheet" className="flex min-h-0 flex-1">
            <WorkflowCatalogDrawer
              sessionId={sessionId}
              onClose={() => closeCatalog(sessionId)}
              onLaunch={(workflow) => openLaunch(sessionId, workflow.path)}
            />
          </div>
        </SheetContent>
      </Sheet>
      {launching === undefined ? null : (
        <LaunchWorkflowDialog
          sessionId={sessionId}
          workflow={launching}
          cwd={state.cwd}
          initialPrompt={state.prompt}
          send={sendSessionFrame}
          onClose={() => closeLaunch(sessionId)}
          onLaunched={() => {
            closeLaunch(sessionId);
            closeCatalog(sessionId);
          }}
        />
      )}
    </>
  );
}
