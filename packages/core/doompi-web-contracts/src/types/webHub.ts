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
  close(): void;
}

export interface WebHubChannel {
  /** Wire frame type; globally unique across every loaded plugin. */
  frameType: string;
  start(host: HubChannelHost): HubChannelSource;
}
