import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import { authorCanvasAlias } from '../../_lib/authorCanvasState';
import { authorCaptureContext, createAuthorCapturePacket, multiRegionCaptureProvider } from '../../_lib/authorCapture';
import type { AuthorWorkspaceDocument, AuthorSessionWorkspace } from '../../_lib/authorWorkspaceStore';
import { AuthorRegionDrafts } from './AuthorRegionDrafts';

export function AuthorFeedbackControls({
  sessionId,
  document,
  workspace,
  submitCapture,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  workspace: AuthorSessionWorkspace;
  submitCapture: WebPluginSlotProps['submitCapture'];
}) {
  const [status, setStatus] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="space-y-2">
      <AuthorRegionDrafts sessionId={sessionId} workspace={workspace} />
      {workspace.annotations.length > 0 ? (
        <Button
          className="min-h-11 min-w-11 w-full text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
          variant="outline"
          data-testid="author-attach-capture"
          disabled={capturing || workspace.candidate !== undefined || submitCapture === undefined}
          onClick={async () => {
            if (capturing || workspace.candidate || submitCapture === undefined) return;
            setCapturing(true);
            setStatus('Submitting annotations…');
            try {
              const packet = createAuthorCapturePacket(
                crypto.randomUUID(),
                Date.now(),
                document,
                workspace.annotations,
                authorCanvasAlias(sessionId, document.path),
              );
              const image = await multiRegionCaptureProvider(workspace.annotations).capture();
              await submitCapture({ ...image, context: authorCaptureContext(packet) });
              setStatus('Request submitted. You can keep annotating here.');
            } catch (reason) {
              setStatus(reason instanceof Error ? reason.message : String(reason));
            } finally {
              setCapturing(false);
            }
          }}
        >
          {capturing
            ? 'Submitting…'
            : `Submit ${workspace.annotations.length} annotation${workspace.annotations.length === 1 ? '' : 's'}`}
        </Button>
      ) : null}
      {submitCapture === undefined ? (
        <output className="text-sm text-doom-red">Submission unavailable. Reload to update the app.</output>
      ) : null}
      {status ? <output className="block text-sm text-doom-dim">{status}</output> : null}
    </div>
  );
}
