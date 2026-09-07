import type { DoomOAuthRedirect } from '@agimon-ai/doompi-extension-contracts/package-api';

/** Matches the window mcp-proxy gives a user to finish a redirect. */
const DEFAULT_RESERVATION_MS = 300_000;

export interface OAuthRedirectResult {
  code: string;
  state: string;
}

interface Reservation {
  /** Settled by whichever comes first, the redirect or the deadline. */
  readonly result: Promise<OAuthRedirectResult>;
  resolve(result: OAuthRedirectResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Set once a redirect has been accepted. The entry outlives that moment so a
   * caller that has not reached `wait` yet still collects the result, while a
   * replay of the same state is refused rather than delivered twice.
   */
  settled: boolean;
}

/** How a delivered redirect was judged, so the route can answer accordingly. */
export type DeliveryOutcome = 'delivered' | 'unknown_state';

export interface OAuthRedirectRegistry {
  /**
   * Lends the hub's redirect surface at a given origin.
   *
   * The origin is read per call rather than captured, so a tunnel that
   * reconnects on a new hostname is reflected by the next flow instead of
   * handing out an address that no longer resolves.
   */
  surface(origin: string): DoomOAuthRedirect;
  /** Hands a redirect to whichever flow reserved its state. */
  deliver(result: OAuthRedirectResult): DeliveryOutcome;
  /** Fails every waiting flow; the hub is shutting down. */
  close(): void;
}

/**
 * The states the hub is currently willing to accept a redirect for.
 *
 * A state is accepted at reservation, not when someone starts waiting on it,
 * because the authorization URL reaches the user the moment it is surfaced and
 * a fast redirect must not arrive before anyone is listening.
 *
 * Process memory only, like the tunnel's own public origin. A restart drops
 * every reservation, which is correct: the flows that owned them died with the
 * process that started them.
 */
export function createOAuthRedirectRegistry(redirectPath: string): OAuthRedirectRegistry {
  const reservations = new Map<string, Reservation>();

  const take = (state: string): Reservation | undefined => {
    const reservation = reservations.get(state);
    if (!reservation) return undefined;
    reservations.delete(state);
    clearTimeout(reservation.timer);
    return reservation;
  };

  const reserve = (state: string, timeoutMs?: number): void => {
    let resolve!: (result: OAuthRedirectResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<OAuthRedirectResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // Nothing awaits this until `wait`, and an expiry that rejected with no
    // handler attached would surface as an unhandled rejection.
    result.catch(() => undefined);

    const timer = setTimeout(() => {
      reservations.delete(state);
      reject(new Error('Timed out waiting for the authorization redirect.'));
    }, timeoutMs ?? DEFAULT_RESERVATION_MS);
    // Never keeps the process alive for a user who walked away.
    timer.unref?.();

    reservations.set(state, { result, resolve, reject, timer, settled: false });
  };

  return {
    surface(origin) {
      return {
        redirectUri: `${origin}${redirectPath}`,
        reserve(state, timeoutMs) {
          // A second reservation would orphan the first flow's waiter, so the
          // caller is told rather than silently displacing it.
          if (reservations.has(state)) {
            return Promise.reject(new Error(`A redirect is already reserved for state ${state}.`));
          }
          reserve(state, timeoutMs);
          return Promise.resolve();
        },
        wait(state) {
          const reservation = reservations.get(state);
          if (!reservation) {
            return Promise.reject(new Error(`No redirect is reserved for state ${state}.`));
          }
          // A delivered result is collected exactly once; keeping the entry any
          // longer would let a replay find it.
          if (reservation.settled) reservations.delete(state);
          return reservation.result;
        },
        cancel(state) {
          take(state)?.reject(new Error('Authorization cancelled.'));
        },
      };
    },

    deliver(result) {
      const reservation = reservations.get(result.state);
      if (!reservation || reservation.settled) return 'unknown_state';
      reservation.settled = true;
      clearTimeout(reservation.timer);
      reservation.resolve(result);
      return 'delivered';
    },

    close() {
      // Cleared in one pass rather than entry by entry, so nothing mutates the
      // map while it is being walked.
      for (const reservation of reservations.values()) {
        clearTimeout(reservation.timer);
        if (!reservation.settled) reservation.reject(new Error('The hub is shutting down.'));
      }
      reservations.clear();
    },
  };
}
