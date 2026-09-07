import fs from 'node:fs';
import path from 'node:path';
import { HUB_ADVERTISEMENT_VERSION, hubAdvertisementPath } from '@agimon-ai/doompi-web-contracts';

export interface AdvertiseHubInput {
  /** The directory the hub and its session servers share. */
  registryDir: string;
  /** Origin of the local listener; never the tunnel's. */
  url: string;
  pid?: number;
  onNotice?: (message: string) => void;
}

/**
 * Publishes where this hub is listening, and withdraws it on close.
 *
 * A local process that wants a session created has to find the hub, and the
 * registry directory is the one location it and the hub already agree on. The
 * alternative is scanning ports, which is worse in every direction: slower,
 * noisier, and it cannot tell this hub from another user's.
 *
 * Only the loopback origin goes in the file, never the tunnel address. The file
 * is `0600` so it is readable only by the account already running the hub, and
 * it names an address that account can reach anyway. It removes guesswork
 * rather than granting reach.
 *
 * Failure to write is a notice, not a throw. Advertisement is a convenience for
 * other processes; a cockpit that serves its browser perfectly well should not
 * refuse to start because a discovery file could not be written.
 */
export function advertiseHub(input: AdvertiseHubInput): () => void {
  const file = hubAdvertisementPath(input.registryDir);
  const record = {
    version: HUB_ADVERTISEMENT_VERSION,
    url: input.url,
    pid: input.pid ?? process.pid,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written through a temp file in the same directory so a reader never sees
    // a half-written record, and opened 0600 from the start rather than being
    // widened and then narrowed.
    const temporary = `${file}.${String(record.pid)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    input.onNotice?.(`could not advertise the cockpit address: ${(error as Error).message}`);
    return () => {};
  }
  return () => {
    try {
      // Only withdraw our own advertisement. A hub that replaced this one has
      // already overwritten the file, and deleting it then would leave the live
      // cockpit undiscoverable for the rest of its life.
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (current.pid === record.pid) fs.rmSync(file, { force: true });
    } catch {
      // Already gone, or unreadable and therefore not ours to remove.
    }
  };
}
