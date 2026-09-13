import net from 'node:net';

/** Environment variable carrying the lifeline socket path to every runner supervisor. */
export const LIFELINE_ENV = 'DOOM_RUNNER_LIFELINE';

/**
 * Reports the owning pi process dying to a runner's supervisor.
 *
 * A connected Unix socket drops the moment the owner's descriptors close, which
 * happens on every exit path including SIGKILL, so it is the one death signal a
 * graceful shutdown handler cannot provide. Connecting never blocks, the close
 * edge arrives through the event loop rather than a poll, and an unref'd socket
 * can never keep the supervisor alive: the watcher is therefore incapable of
 * outliving the process that installed it.
 *
 * A refused or missing socket means the owner died before this runner started,
 * which is reported the same way as a later death rather than left to hang.
 *
 * Runners run unwatched when no lifeline is armed, so a missing environment
 * variable can never be mistaken for a dead owner.
 */
export function watchOwner(
  onOwnerLost: () => void,
  target: string | undefined = process.env[LIFELINE_ENV],
): () => void {
  if (!target) return () => undefined;

  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onOwnerLost();
  };

  let connection: net.Socket;
  try {
    connection = net.connect(target);
  } catch (error) {
    process.emitWarning(`Could not watch the doom-runner lifeline: ${String(error)}`);
    return () => undefined;
  }

  // The supervisor's own exit must never wait on this socket.
  connection.unref();
  // The owner never sends anything, so drain rather than accumulate.
  connection.on('connect', () => connection.resume());
  connection.on('error', settle);
  connection.on('close', settle);

  return () => {
    settled = true;
    connection.destroy();
  };
}
