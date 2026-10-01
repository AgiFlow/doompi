import { defineSessionStore } from '@agimon-ai/doompi-core/web';
/**
 * Review comments queued on this session, waiting to go to the agent as one
 * message.
 *
 * DESIGN PATTERNS:
 * - Session-scoped and in memory: comments survive closing and reopening the
 *   review tab, not a page reload. The same trade the files tab makes.
 * - Comments are cleared only after a send the host accepted, never before.
 */
import type { ReviewComment } from '@agimon-ai/doompi-web-components';

export interface GitReviewSession {
  comments: ReviewComment[];
}

export const gitReview = defineSessionStore<GitReviewSession>({ comments: [] });

export function addReviewComment(sessionId: string, comment: Omit<ReviewComment, 'id'>): void {
  const id = globalThis.crypto.randomUUID();
  gitReview.update(sessionId, (current) => ({ comments: [...current.comments, { ...comment, id }] }));
}

export function removeReviewComment(sessionId: string, id: string): void {
  gitReview.update(sessionId, (current) => ({ comments: current.comments.filter((comment) => comment.id !== id) }));
}

export function clearReviewComments(sessionId: string): void {
  gitReview.update(sessionId, () => ({ comments: [] }));
}
