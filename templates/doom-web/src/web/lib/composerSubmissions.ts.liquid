import type { ComposerSubmission } from '@agimon-ai/doompi-web-contracts';

type ComposerSubmissionListener = (submission: ComposerSubmission) => void;

const listeners = new Set<ComposerSubmissionListener>();

export function onComposerSubmitted(listener: ComposerSubmissionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishComposerSubmission(submission: ComposerSubmission): void {
  const snapshot: ComposerSubmission = {
    ...submission,
    contextItems: submission.contextItems.map((item) => ({ ...item })),
  };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // A plugin observer cannot roll back a message the session already accepted.
    }
  }
}
