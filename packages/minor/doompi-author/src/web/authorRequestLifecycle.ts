import type { ComposerSubmission } from '@agimon-ai/doompi-web-contracts';
import type { AuthorCapturePacket } from './authorCapture.ts';
import type { AuthorRegionDraft } from './authorViewportTypes.ts';
import { authorSessionWorkspace, putAuthorRequest, removeAuthorRegion } from './authorWorkspaceStore.ts';

function capturePacket(content: string): AuthorCapturePacket | undefined {
  try {
    const value = JSON.parse(content) as Partial<AuthorCapturePacket>;
    if (
      value.version !== 1 ||
      typeof value.captureId !== 'string' ||
      typeof value.capturedAt !== 'number' ||
      typeof value.document?.path !== 'string' ||
      typeof value.document.revision !== 'number' ||
      !Array.isArray(value.regions) ||
      value.regions.length === 0
    ) {
      return undefined;
    }
    return value as AuthorCapturePacket;
  } catch {
    return undefined;
  }
}

export function recordAuthorComposerSubmission(submission: ComposerSubmission): void {
  for (const item of submission.contextItems) {
    if (item.source !== 'author' || item.kind !== 'author-capture') continue;
    const packet = capturePacket(item.content);
    if (packet === undefined || packet.captureId !== item.id) continue;
    if (authorSessionWorkspace(submission.sessionId).requests.some((request) => request.captureId === packet.captureId))
      continue;
    const regions: AuthorRegionDraft[] = packet.regions.map((region) => ({
      id: region.id,
      documentPath: packet.document.path,
      revision: packet.document.revision,
      sourceSha256: packet.document.sourceSha256,
      comment: region.comment,
      quote: region.quote,
      anchor: structuredClone(region.anchor),
      viewport: { ...region.viewport },
      voiceGrid: region.voiceGrid && { ...region.voiceGrid },
      createdAt: packet.capturedAt,
    }));
    putAuthorRequest(submission.sessionId, {
      id: crypto.randomUUID(),
      captureId: packet.captureId,
      documentPath: packet.document.path,
      requestText: submission.message,
      regions,
      pendingRegions: regions,
      status: 'REQUESTED',
      createdAt: submission.submittedAt,
      updatedAt: submission.submittedAt,
      revision: packet.document.revision,
      sourceSha256: packet.document.sourceSha256,
    });
    for (const region of packet.regions) removeAuthorRegion(submission.sessionId, region.id);
  }
}
