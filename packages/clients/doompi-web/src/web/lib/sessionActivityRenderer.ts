import type { ReactNode } from 'react';

type SessionActivityRenderer = (sessionId: string, onOpenConversation: () => void) => ReactNode;

let render: SessionActivityRenderer | undefined;

/** Binds the host's live session activity view without exposing host stores to plugins. */
export function bindSessionActivityRenderer(renderer: SessionActivityRenderer): void {
  render = renderer;
}

export function releaseSessionActivityRenderer(): void {
  render = undefined;
}

/** The bound session activity view, or nothing before the app mounts and in unit tests. */
export function renderSessionActivity(sessionId: string, onOpenConversation: () => void): ReactNode {
  return render?.(sessionId, onOpenConversation) ?? null;
}
