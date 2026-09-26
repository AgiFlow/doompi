import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { useStore } from '@tanstack/react-store';

import { autonomousVoiceGridVisible } from '../../_components/AuthorGridOverlay';
import { authorGrid } from '../../_lib/authorGrid';
import { authorWorkspace } from '../../_lib/authorWorkspaceStore';
import { AuthorFeedbackControls } from './AuthorFeedbackControls';
import { AuthorRequestLog } from './AuthorRequestLog';
import { AuthorToolPalette } from './AuthorToolPalette';

export function AuthorPanel({
  sessionId,
  activeMinorModes,
  submitCapture,
  statuses,
  renderSlot,
  renderSessionActivity,
}: WebPluginSlotProps) {
  const documents = useStore(authorWorkspace.store, (state) => {
    if (sessionId === null) return [];
    const prefix = `${sessionId}\n`;
    return Object.entries(state.documents)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, document]) => document);
  });
  const workspace = useStore(authorWorkspace.store, (state) =>
    sessionId === null ? undefined : state.sessions[sessionId],
  );
  const grid = useStore(authorGrid.store, (state) => (sessionId === null ? undefined : state.sessions[sessionId]));
  const focused = documents.find((document) => document.path === workspace?.focusedDocument?.path);
  const activity = sessionId === null ? null : (renderSessionActivity?.() ?? null);
  if (!activeMinorModes?.includes('author')) return null;
  return (
    <section data-testid="author-panel" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          <div data-testid="author-preview-providers">{renderSlot('author.preview-provider')}</div>
          {sessionId !== null && workspace !== undefined && focused !== undefined ? (
            <>
              <h2 className="text-base font-semibold text-doom-text">Annotations</h2>
              <p className="text-base leading-normal text-doom-dim sm:text-sm">
                Drag a region or place a point, add feedback, then submit here. Requests queue while the agent is
                working.
              </p>
              {focused.kind === 'video' ? (
                <p className="text-base text-doom-dim sm:text-sm">
                  Annotations reference video frames. They do not save changes to the source video.
                </p>
              ) : null}
              <AuthorToolPalette sessionId={sessionId} kind={focused.kind} activeTool={workspace.activeTool} />
              {autonomousVoiceGridVisible(statuses) && grid !== undefined ? (
                <div
                  data-testid="author-grid-snapshot"
                  className="rounded border border-doom-red/40 bg-doom-red/5 p-2 text-base text-doom-dim"
                >
                  <strong className="text-doom-red">VOICE GRID A1–H8</strong>
                  <p className="mt-1 truncate">token {grid.geometryToken}</p>
                </div>
              ) : null}
              <div className="hidden sm:block">
                <AuthorFeedbackControls
                  key={focused.path}
                  sessionId={sessionId}
                  document={focused}
                  workspace={workspace}
                  submitCapture={submitCapture}
                />
              </div>
            </>
          ) : null}
          <AuthorRequestLog requests={workspace?.requests ?? []} />
        </div>
      </div>
      {activity === null ? null : (
        <footer data-testid="author-session-activity" className="shrink-0 border-t border-doom-border bg-doom-rail p-3">
          {activity}
        </footer>
      )}
    </section>
  );
}
