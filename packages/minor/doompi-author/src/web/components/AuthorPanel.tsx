import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import {
  authorCaptureContext,
  createAuthorCapturePacket,
  multiRegionCaptureProvider,
} from '../stores/authorCapture.ts';
import { authorGrid } from '../lib/authorGrid.ts';
import { autonomousVoiceGridVisible } from './AuthorGridOverlay.tsx';
import { authorWorkspace } from '../stores/authorWorkspaceStore.ts';
import { AuthorToolPalette } from './AuthorToolPalette.tsx';
import { AuthorRegionDrafts } from './AuthorRegionDrafts.tsx';
import { AuthorRequestLog } from './AuthorRequestLog.tsx';

export function AuthorPanel({ sessionId, activeMinorModes, submitCapture, statuses }: WebPluginSlotProps) {
  const [captureStatus, setCaptureStatus] = useState<string>();
  const [capturing, setCapturing] = useState(false);
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
    <section data-testid="author-panel" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      {sessionId !== null && workspace !== undefined && focused !== undefined ? (
        <>
          <h2 className="text-base font-semibold text-doom-text">Annotations</h2>
          <p className="text-base leading-normal text-doom-dim sm:text-sm">
            Select a region, add a comment, then submit here. Requests queue while the agent is working.
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
          <AuthorRegionDrafts key={focused.path} sessionId={sessionId} workspace={workspace} />
          {workspace.regions.length > 0 ? (
            <div className="space-y-1.5 border-b border-doom-border-soft pb-3">
              <Button
                className="min-h-11 min-w-11 w-full text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
                variant="outline"
                data-testid="author-attach-capture"
                disabled={capturing || workspace.candidate !== undefined || submitCapture === undefined}
                onClick={async () => {
                  if (capturing || workspace.candidate || submitCapture === undefined) return;
                  setCapturing(true);
                  setCaptureStatus('Submitting annotations…');
                  try {
                    const packet = createAuthorCapturePacket(
                      crypto.randomUUID(),
                      Date.now(),
                      focused,
                      workspace.regions,
                    );
                    const image = await multiRegionCaptureProvider(workspace.regions).capture();
                    await submitCapture({ ...image, context: authorCaptureContext(packet) });
                    setCaptureStatus('Request submitted. You can keep annotating here.');
                  } catch (reason) {
                    setCaptureStatus(reason instanceof Error ? reason.message : String(reason));
                  } finally {
                    setCapturing(false);
                  }
                }}
              >
                {capturing
                  ? 'Submitting…'
                  : `Submit ${workspace.regions.length} annotation${workspace.regions.length === 1 ? '' : 's'}`}
              </Button>
              {workspace.candidate ? (
                <p className="text-base text-doom-dim sm:text-sm">
                  Add or discard the current selection before submitting.
                </p>
              ) : null}
            </div>
          ) : null}
          {submitCapture === undefined ? (
            <output className="text-sm text-doom-red">Submission unavailable. Reload to update the app.</output>
          ) : null}
          {captureStatus ? <output className="block text-sm text-doom-dim">{captureStatus}</output> : null}
        </>
      ) : null}
      <AuthorRequestLog requests={workspace?.requests ?? []} />
    </section>
  );
}
