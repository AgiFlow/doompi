import net from 'node:net';

/**
 * Which loopback address a local dev server is actually listening on.
 *
 * Vite binds `localhost`, which on a machine with IPv6 resolves to `::1` and
 * nothing answers on `127.0.0.1`. Other servers do the opposite. Dialling the
 * wrong one is an immediate ECONNREFUSED, which looks to the developer like
 * the proxy is broken rather than like an address-family mismatch.
 *
 * This is deliberately not a resolver. The candidates are two hard-coded
 * loopback literals and the only input is a port number, so there is no
 * hostname to poison and no DNS-rebinding window: the answer can only ever be
 * this machine.
 */

/** IPv4 first: it is what a developer types, so preferring it keeps logs recognizable. */
const CANDIDATES = ['127.0.0.1', '::1'] as const;
const PROBE_TIMEOUT_MS = 400;

export type LoopbackAddress = (typeof CANDIDATES)[number];

/** Remembered per port so a page of eighty assets probes once, not eighty times. */
const known = new Map<number, LoopbackAddress>();

async function accepts(host: LoopbackAddress, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * The loopback address answering on this port, preferring a remembered one.
 *
 * Falls back to IPv4 when neither answers, so the caller's own connection
 * produces the real ECONNREFUSED and its message, rather than this probe
 * inventing a different error for the same condition.
 */
export async function loopbackFor(port: number): Promise<LoopbackAddress> {
  const remembered = known.get(port);
  if (remembered !== undefined && (await accepts(remembered, port))) return remembered;
  for (const candidate of CANDIDATES) {
    if (await accepts(candidate, port)) {
      known.set(port, candidate);
      return candidate;
    }
  }
  known.delete(port);
  return CANDIDATES[0];
}

/** Test seam. */
export function forgetLoopbackAddresses(): void {
  known.clear();
}
