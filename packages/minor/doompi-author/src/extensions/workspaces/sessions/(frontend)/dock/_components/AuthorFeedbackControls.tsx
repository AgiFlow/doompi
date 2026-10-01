import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import { authorCanvasAlias } from '../../_lib/authorCanvasState';
import { authorCaptureContext, createAuthorCapturePacket, multiRegionCaptureProvider } from '../../_lib/authorCapture';
import type { AuthorWorkspaceDocument, AuthorDocumentAnnotationCollection } from '../../_lib/authorWorkspaceStore';
import { AuthorRegionDrafts } from './AuthorRegionDrafts';

export function AuthorFeedbackControls({
  sessionId,
  document,
  drafts,
  submitCapture,
}: {
  sessionId: string;
  document: AuthorWorkspaceDocument;
  drafts: AuthorDocumentAnnotationCollection;
  submitCapture: WebPluginSlotProps['submitCapture'];
}) {
  const [status, setStatus] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="space-y-2">
      <AuthorRegionDrafts sessionId={sessionId} path={document.path} drafts={drafts} />
      {drafts.annotations.length > 0 ? (
        <Button
          className="min-h-11 min-w-11 w-full text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
          variant="outline"
          data-testid="author-attach-capture"
          disabled={capturing || drafts.candidate !== undefined || submitCapture === undefined}
          onClick={async () => {
            if (capturing || drafts.candidate || submitCapture === undefined) return;
            setCapturing(true);
            setStatus('Submitting annotations…');
            try {
              const packet = createAuthorCapturePacket(
                crypto.randomUUID(),
                Date.now(),
                document,
                drafts.annotations,
                authorCanvasAlias(sessionId, document.path),
              );
              const image = await multiRegionCaptureProvider(drafts.annotations).capture();
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
            : `Submit ${drafts.annotations.length} annotation${drafts.annotations.length === 1 ? '' : 's'}`}
        </Button>
      ) : null}
      {submitCapture === undefined ? (
        <output className="text-sm text-doom-red">Submission unavailable. Reload to update the app.</output>
      ) : null}
      {status ? <output className="block text-sm text-doom-dim">{status}</output> : null}
    </div>
  );
}
