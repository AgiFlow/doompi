import { Store } from '@tanstack/store';
import type { CaptureStatusEvent, ComposerCapture, ComposerSubmission } from '@agimon-ai/doompi-web-contracts';
import { validateComposerCapture } from './composerStore.ts';
import { sessionStoreFor } from './sessionStore.ts';
import { sessionsStore } from './sessionsStore.ts';
import { publishComposerSubmission } from '../lib/composerSubmissions.ts';
import { sendFrame } from '../lib/transport.ts';

interface PendingCapture {
  submission: ComposerSubmission;
  captureId: string;
  accepted: boolean;
  working: boolean;
  executionError?: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, PendingCapture>();
const listeners = new Set<(event: CaptureStatusEvent) => void>();
/** Pending delivery and execution own a subscription independently of route focus. */
export const pendingCaptureSessions = new Store<ReadonlySet<string>>(new Set<string>());

function publishPendingSessions(): void {
  pendingCaptureSessions.setState(() => new Set([...pending.values()].map(({ submission }) => submission.sessionId)));
}

export function onCaptureStatus(listener: (event: CaptureStatusEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function accept(request: PendingCapture): void {
  if (request.accepted) return;
  request.accepted = true;
  clearTimeout(request.timer);
  publishComposerSubmission(request.submission);
  request.resolve();
}

function status(request: PendingCapture, value: CaptureStatusEvent['status'], error?: string): void {
  for (const listener of listeners) {
    try {
      listener({
        sessionId: request.submission.sessionId,
        captureId: request.captureId,
        status: value,
        ...(error ? { error } : {}),
      });
    } catch {
      // Observers cannot change delivery or execution.
    }
  }
}

function fail(id: string, request: PendingCapture, error: string): void {
  clearTimeout(request.timer);
  pending.delete(id);
  publishPendingSessions();
  if (request.accepted) status(request, 'error', error);
  else request.reject(new Error(error));
}

/** Direct delivery never reads or mutates a composer draft. Resolution means accepted, not completed. */
export async function submitCapture(sessionId: string | null, capture: ComposerCapture): Promise<void> {
  validateComposerCapture(capture);
  if (sessionId === null || sessionsStore.state.byId[sessionId]?.attach !== 'attached') {
    throw new Error('The session is not connected.');
  }
  if (
    [...pending.values()].some(
      (request) => request.submission.sessionId === sessionId && request.captureId === capture.context.id,
    )
  ) {
    throw new Error('This capture is already pending.');
  }
  const id = `capture-${crypto.randomUUID()}`;
  const queued =
    sessionStoreFor(sessionId).state.streaming ||
    [...pending.values()].some((request) => request.submission.sessionId === sessionId);
  // Include both semantic context identity and a unique delivery identity on the actual user message.
  const message = `Please address the attached feedback.\nRequest ID: ${id}\n\nReferenced context ${JSON.stringify(capture.context.label)}:\n\n${capture.context.content}`;
  await new Promise<void>((resolve, reject) => {
    const request: PendingCapture = {
      submission: {
        sessionId,
        message,
        delivery: queued ? 'queue' : 'submit',
        submittedAt: Date.now(),
        contextItems: [{ ...capture.context }],
      },
      captureId: capture.context.id,
      accepted: false,
      working: false,
      resolve,
      reject,
      timer: setTimeout(() => fail(id, request, 'Capture acceptance was not confirmed.'), 30_000),
    };
    pending.set(id, request);
    try {
      publishPendingSessions();
      sendFrame(sessionId, {
        id,
        type: queued ? 'follow_up' : 'prompt',
        message,
        images: [{ type: 'image', data: capture.data, mimeType: capture.mimeType }],
      });
    } catch (error) {
      fail(id, request, error instanceof Error ? error.message : 'Capture delivery failed.');
    }
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
function messageText(message: Record<string, unknown> | undefined): string | undefined {
  if (message?.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content.map((part: unknown) => (record(part)?.type === 'text' ? record(part)?.text : '')).join('');
}

/** Live frames only: a backlog must never claim a fresh execution. */
export function applyCaptureFrame(sessionId: string, frame: Record<string, unknown>): void {
  const entry = frame.type === 'entry_appended' ? record(frame.entry) : undefined;
  const text = messageText(frame.type === 'message_start' ? record(frame.message) : record(entry?.message));
  for (const [id, request] of pending) {
    if (request.submission.sessionId !== sessionId) continue;
    if (frame.type === 'response' && frame.id === id) {
      if (frame.success === false)
        fail(id, request, typeof frame.error === 'string' ? frame.error : 'Capture rejected.');
      else if (frame.success === true) {
        accept(request);
        if (!request.working) status(request, 'queued');
      }
    }
    if (text?.includes(`Request ID: ${id}`) === true && !request.working) {
      accept(request);
      request.working = true;
      status(request, 'working');
    }
    if (
      frame.type === 'response' &&
      frame.success === true &&
      (frame.command === 'abort' || frame.command === 'clear_queue')
    ) {
      if (frame.command === 'abort' || !request.working) fail(id, request, 'Capture cancelled.');
    } else if (request.working && (frame.type === 'error' || frame.type === 'extension_error')) {
      fail(id, request, typeof frame.message === 'string' ? frame.message : 'Capture execution failed.');
    } else if (request.working && frame.type === 'message_end') {
      const stopReason = record(frame.message)?.stopReason;
      if (stopReason === 'error' || stopReason === 'aborted') {
        request.executionError = 'Capture execution failed or was cancelled.';
      }
    } else if (request.working && (frame.type === 'agent_settled' || frame.type === 'agent_end')) {
      const messages = Array.isArray(frame.messages) ? frame.messages : [];
      const failed =
        request.executionError ??
        (messages.some((message: unknown) => ['error', 'aborted'].includes(String(record(message)?.stopReason)))
          ? 'Capture execution failed or was cancelled.'
          : undefined);
      pending.delete(id);
      publishPendingSessions();
      status(request, failed === undefined ? 'completed' : 'error', failed);
    }
  }
}

export function disconnectCaptures(sessionId?: string): void {
  for (const [id, request] of pending) {
    if (sessionId === undefined || request.submission.sessionId === sessionId)
      fail(id, request, 'Capture execution lost its connection.');
  }
}
