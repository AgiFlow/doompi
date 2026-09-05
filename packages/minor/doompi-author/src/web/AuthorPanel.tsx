import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import {
  attachAuthorCapture,
  authorCaptureContext,
  createAuthorCapturePacket,
  multiRegionCaptureProvider,
} from './authorCapture.ts';
import { authorGrid } from './authorGrid.ts';
import { autonomousVoiceGridVisible } from './AuthorGridOverlay.tsx';
import { authorWorkspace } from './authorWorkspaceStore.ts';
import { AuthorToolPalette } from './AuthorToolPalette.tsx';
import { AuthorRegionDrafts } from './AuthorRegionDrafts.tsx';
import { AuthorRequestLog } from './AuthorRequestLog.tsx';

export function AuthorPanel({ sessionId, activeMinorModes, attachComposerCapture, statuses }: WebPluginSlotProps) {
  const [captureStatus, setCaptureStatus] = useState<string>();
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
  if (!activeMinorModes?.includes('author') || focused === undefined) return null;
  return (
    <section data-testid="author-panel" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
      {sessionId !== null && workspace !== undefined && focused !== undefined ? (
        <>
          <AuthorToolPalette sessionId={sessionId} kind={focused.kind} activeTool={workspace.activeTool} />
          {autonomousVoiceGridVisible(statuses) && grid !== undefined ? (
            <div
              data-testid="author-grid-snapshot"
              className="rounded border border-doom-red/40 bg-doom-red/5 p-2 text-[9px] text-doom-dim"
            >
              <strong className="text-doom-red">VOICE GRID A1–H8</strong>
              <p className="mt-1 truncate">token {grid.geometryToken}</p>
            </div>
          ) : null}
          <AuthorRegionDrafts key={focused.path} sessionId={sessionId} workspace={workspace} />
          {workspace.regions.length > 0 ? (
            <div className="space-y-1.5 border-b border-doom-border-soft pb-3">
              <Button
                size="xs"
                variant="outline"
                data-testid="author-attach-capture"
                onClick={() => {
                  setCaptureStatus('capturing…');
                  const captureId = crypto.randomUUID();
                  try {
                    const packet = createAuthorCapturePacket(captureId, Date.now(), focused, workspace.regions);
                    void attachAuthorCapture(
                      multiRegionCaptureProvider(workspace.regions),
                      authorCaptureContext(packet),
                      attachComposerCapture,
                    ).then(
                      () => setCaptureStatus('attached to composer'),
                      (reason: unknown) => setCaptureStatus(reason instanceof Error ? reason.message : String(reason)),
                    );
                  } catch (reason) {
                    setCaptureStatus(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                attach {workspace.regions.length} region{workspace.regions.length === 1 ? '' : 's'}
              </Button>
              {captureStatus ? <output className="block text-[10px] text-doom-dim">{captureStatus}</output> : null}
            </div>
          ) : null}
        </>
      ) : null}
      <AuthorRequestLog requests={workspace?.requests ?? []} />
    </section>
  );
}
