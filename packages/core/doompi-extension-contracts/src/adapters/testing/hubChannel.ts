import type {
  DoomHubChannel,
  DoomHubChannelFrame,
  DoomHubChannelHost,
  DoomHubChannelSource,
  DoomHubSessionScope,
} from '../../schemas/hubChannel.ts';

export interface DoomHubChannelHarness {
  source: DoomHubChannelSource;
  readonly published: readonly DoomHubChannelFrame[];
  readonly notices: readonly string[];
  snapshot(sessionId?: string): unknown;
  addSession(scope: DoomHubSessionScope): void;
  removeSession(sessionId: string): void;
  close(): void;
}

export interface DoomHubChannelHarnessOptions {
  sessions?: readonly DoomHubSessionScope[];
}

const DEFAULT_SESSION: DoomHubSessionScope = { sessionId: 's1', cwd: '/repo' };

export function doomHubChannelHarness(
  channel: DoomHubChannel,
  options: DoomHubChannelHarnessOptions = {},
): DoomHubChannelHarness {
  const sessions = [...(options.sessions ?? [DEFAULT_SESSION])];
  const published: DoomHubChannelFrame[] = [];
  const notices: string[] = [];
  const host: DoomHubChannelHost = {
    sessions: () => sessions,
    directEvents: {
      publish: () => undefined,
      subscribe: () => () => undefined,
      close: () => undefined,
    },
    publish: (sessionId, payload) => {
      published.push({ type: channel.frameType, sessionId, payload });
    },
    requestSessionApi: () =>
      Promise.resolve(Response.json({ error: 'No session API in the channel harness.' }, { status: 501 })),
    onNotice: (message) => notices.push(message),
  };
  const source = channel.start(host);

  return {
    source,
    published,
    notices,
    snapshot(sessionId) {
      const scope = sessions.find((candidate) => candidate.sessionId === sessionId) ?? sessions[0] ?? DEFAULT_SESSION;
      return source.payloadFor(scope);
    },
    addSession(scope) {
      sessions.push(scope);
      source.sessionAdded?.(scope);
    },
    removeSession(sessionId) {
      const index = sessions.findIndex((candidate) => candidate.sessionId === sessionId);
      if (index >= 0) sessions.splice(index, 1);
      source.sessionRemoved?.(sessionId);
    },
    close: () => source.close(),
  };
}
