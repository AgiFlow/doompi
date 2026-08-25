/**
 * The wire shape and the hub-server half of the DoomPi web plugin contract.
 *
 * A plugin package's hub entry exports `webHubChannels: readonly
 * WebHubChannel[]`. The cockpit hub imports server contracts type-only, so
 * this module must stay free of runtime values beyond plain types.
 */

/**
 * Per-plugin session data on the page socket. The channel name IS the frame
 * type; the page routes by registry lookup and drops unknown types.
 */
export interface ChannelFrame {
  type: string;
  sessionId: string;
  payload: unknown;
}

export interface HubSessionScope {
  sessionId: string;
  /** The session's working directory, for repo-scoped data sources. */
  cwd: string;
}

/** What the hub hands a channel when it starts. */
export interface HubChannelHost {
  /** Every session the hub currently manages. */
  sessions(): readonly HubSessionScope[];
  /** Live fan-out to the session's page subscribers. */
  publish(sessionId: string, payload: unknown): void;
  onNotice(message: string): void;
}

/**
 * One running data source. `payloadFor` answers the subscribe-time snapshot;
 * undefined means no frame. The optional session hooks cover per-session
 * sources; a hub-wide source may ignore them and filter inside itself.
 */
export interface HubChannelSource {
  /** unknown already admits undefined; a literal undefined result means no frame. */
  payloadFor(scope: HubSessionScope): unknown;
  sessionAdded?(scope: HubSessionScope): void;
  sessionRemoved?(sessionId: string): void;
  /**
   * The Pi session journal (an absolute .jsonl path) behind one thread of a
   * session, such as a subagent run; the hub tails it for the page. Undefined
   * means not this source's thread, or not known yet: the hub keeps asking.
   */
  threadJournal?(scope: HubSessionScope, threadId: string): string | undefined;
  close(): void;
}

export interface WebHubChannel {
  /** Wire frame type; globally unique across every loaded plugin. */
  frameType: string;
  start(host: HubChannelHost): HubChannelSource;
}

/** What the hub hands a plugin's HTTP surface when it starts. */
export interface WebHubApiContext {
  /** Every session the hub currently manages. */
  sessions(): readonly HubSessionScope[];
  /** One managed session, or undefined when the hub does not have it; a route refuses rather than guesses. */
  session(sessionId: string): HubSessionScope | undefined;
  onNotice(message: string): void;
}

/**
 * One running HTTP surface. `fetch` is the whole handler, so any framework
 * that speaks Request/Response satisfies it and no package is forced onto the
 * one the hub happens to use. The hub strips the mount prefix before calling,
 * so routes are declared relative to it ('/sessions/:sessionId/...') and the
 * plugin never repeats where it was mounted.
 */
export interface WebHubApiHandler {
  fetch(request: Request): Response | Promise<Response>;
  close(): void;
}

/**
 * A plugin's HTTP API, the server-side sibling of its data channels: the hub
 * mounts it under /api/plugin/<basePath>/ and forwards every request beneath
 * that prefix. A page reaches it with a plain fetch, which is the one thing a
 * data channel cannot do, because a channel only ever pushes.
 */
export interface WebHubApi {
  /** Segment under /api/plugin/; by convention the pluginId, and globally unique across loaded plugins. */
  basePath: string;
  start(context: WebHubApiContext): WebHubApiHandler;
}
