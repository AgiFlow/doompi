import type { ReactNode } from 'react';

type ThreadRenderer = (sessionId: string, threadId: string) => ReactNode;

let render: ThreadRenderer | undefined;

/**
 * Holds the host's thread view for the plugin props to render.
 *
 * The view is a feature built on the timeline, while the props are assembled
 * below it; the composition root binds the one to the other, the same
 * indirection the transport uses for the socket.
 */
export function bindThreadRenderer(renderer: ThreadRenderer): void {
  render = renderer;
}

export function releaseThreadRenderer(): void {
  render = undefined;
}

/** The bound view, or nothing while none is bound (before the app mounts, and in unit tests). */
export function renderThread(sessionId: string, threadId: string): ReactNode {
  return render?.(sessionId, threadId) ?? null;
}
