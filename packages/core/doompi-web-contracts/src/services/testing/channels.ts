import type {
  ChannelFrame,
  HubChannelHost,
  HubChannelSource,
  HubSessionScope,
  WebHubChannel,
} from '../../types/webHub.ts';
import type { SessionChannelContribution } from '../../types/webPlugin.ts';

/**
 * The two halves of a plugin's data channel, driven the way the hub drives them.
 *
 * A channel is the one place a plugin parses input it did not produce, so its
 * parse gate is the boundary that matters, and a test that calls `apply`
 * directly steps straight over it. `driveChannel` sends a wire payload the way
 * the page does: through `parse` first, and nothing applied when it is
 * rejected.
 */

export interface ChannelDelivery {
  /** Whether the parse gate accepted the payload. */
  accepted: boolean;
}

/**
 * Sends one wire payload to a session channel.
 *
 * Returns whether the gate accepted it, so a test can assert a rejection
 * without knowing what the plugin's parsed shape looks like.
 */
export function driveChannel(
  channel: SessionChannelContribution,
  sessionId: string,
  payload: unknown,
): ChannelDelivery {
  const parsed: unknown = channel.parse(payload);
  if (parsed === null) return { accepted: false };
  channel.apply(sessionId, parsed);
  return { accepted: true };
}

export interface HubChannelHarness {
  /** The running source, as the hub holds it. */
  source: HubChannelSource;
  /** Everything the source pushed, in order. */
  readonly published: readonly ChannelFrame[];
  /** What the source told the hub. */
  readonly notices: readonly string[];
  /** The subscribe-time snapshot one session would receive; undefined means no frame. */
  snapshot(sessionId?: string): unknown;
  /** Registers a session with the source, as the hub does when one appears. */
  addSession(scope: HubSessionScope): void;
  removeSession(sessionId: string): void;
  close(): void;
}

export interface HubChannelHarnessOptions {
  /** Sessions the hub already manages when the channel starts. */
  sessions?: readonly HubSessionScope[];
}

const DEFAULT_SESSION: HubSessionScope = { sessionId: 's1', cwd: '/repo' };

/**
 * A plugin's hub channel, started against a real host.
 *
 * The hub calls `payloadFor` once per subscriber and pushes through `publish`
 * afterwards, and a channel that only answers one of those looks correct in a
 * test that exercises the other.
 */
export function hubChannelHarness(channel: WebHubChannel, options: HubChannelHarnessOptions = {}): HubChannelHarness {
  const sessions = [...(options.sessions ?? [DEFAULT_SESSION])];
  const published: ChannelFrame[] = [];
  const notices: string[] = [];
  const host: HubChannelHost = {
    sessions: () => sessions,
    publish: (sessionId, payload) => {
      published.push({ type: channel.frameType, sessionId, payload });
    },
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
