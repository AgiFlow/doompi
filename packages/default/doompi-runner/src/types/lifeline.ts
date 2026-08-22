/**
 * A Unix socket the owning pi process listens on for the life of a session.
 *
 * Runner supervisors connect to it and watch for the close edge, which arrives
 * on every owner exit path including SIGKILL. That is the one death signal a
 * graceful shutdown handler cannot provide.
 */
export interface ILifeline {
  /** Binds the socket and starts listening. Idempotent; resolves with the path. */
  arm(sessionId: string): Promise<string | undefined>;
  /** Path of the armed lifeline, if arming succeeded. */
  path(): string | undefined;
  /** Stops listening and removes the socket. */
  dispose(): void;
}
