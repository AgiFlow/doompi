import type { ThreadViewOptions } from '@agimon-ai/doompi-core/web';
import type { ReactNode } from 'react';

type SessionTranscriptRenderer = (sessionId: string, options?: ThreadViewOptions) => ReactNode;

let render: SessionTranscriptRenderer | undefined;

/** Binds the host's conversation view of another session without exposing host stores to plugins. */
export function bindSessionTranscriptRenderer(renderer: SessionTranscriptRenderer): void {
  render = renderer;
}

export function releaseSessionTranscriptRenderer(): void {
  render = undefined;
}

/** The bound conversation view, or nothing before the app mounts and in unit tests. */
export function renderSessionTranscript(sessionId: string, options?: ThreadViewOptions): ReactNode {
  return render?.(sessionId, options) ?? null;
}
