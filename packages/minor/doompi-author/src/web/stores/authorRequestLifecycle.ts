import type { CaptureStatusEvent, ComposerSubmission } from '@agimon-ai/doompi-web-contracts';
import type { AuthorCapturePacket } from './authorCapture';
import type { AuthorRegionDraft } from '../lib/authorViewportTypes';
import {
  authorSessionWorkspace,
  putAuthorRequest,
  removeAuthorRegion,
  updateAuthorRequest,
} from './authorWorkspaceStore';

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
    const packet = capturePacket(item.metadata ?? item.content);
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

/** Only the host's correlated execution events may settle a submitted capture. */
export function recordAuthorCaptureStatus(event: CaptureStatusEvent): void {
  const request = authorSessionWorkspace(event.sessionId).requests.find(
    (record) => record.captureId === event.captureId,
  );
  if (request === undefined || ['COMPLETE', 'FAILED', 'CANCELLED'].includes(request.status)) return;
  if (event.status === 'queued') return;
  updateAuthorRequest(event.sessionId, request.id, (record) => ({
    ...record,
    status: event.status === 'working' ? 'CHANGING' : event.status === 'completed' ? 'COMPLETE' : 'FAILED',
    currentOperation: event.status === 'working' ? 'Agent is working on this request' : undefined,
    pendingRegions: event.status === 'completed' ? [] : record.pendingRegions,
    error: event.status === 'error' ? event.error || 'Request execution failed.' : undefined,
    updatedAt: Date.now(),
  }));
}
