import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSyncedRoot = vi.hoisted(() => vi.fn());
const readStartupBootstrapStatus = vi.hoisted(() => vi.fn());
vi.mock('../src/adapters/bootstrapLocator.ts', () => ({ findSyncedRoot, readStartupBootstrapStatus }));

import dedicatedPiExtension from '../src/exports/extensions/pi';
import doomPiPackageExtension from '../src/exports/index';

/** Enough of Pi's surface for the bootstrap to park its release handler on. */
const pi = { on: vi.fn() } as unknown as ExtensionAPI;

function bootstrapModule(source: string): { directory: string; bootstrap: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-package-entry-'));
  const bootstrap = path.join(directory, 'bootstrap.mjs');
  fs.writeFileSync(bootstrap, source);
  return { directory, bootstrap };
}

let repositoryCount = 0;

/**
 * A repository root no other case has loaded.
 *
 * The bootstrap claims a root for the whole process and releases it on
 * `session_start`, which this stub Pi never fires, so sharing one root between
 * cases would make every case after the first stand down.
 */
function syncedRoot(): string {
  repositoryCount += 1;
  return `/repo-${String(repositoryCount)}`;
}

describe('DoomPi package extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shares one callable factory between the public root and dedicated Pi entry', () => {
    expect(dedicatedPiExtension).toBe(doomPiPackageExtension);
    expect(typeof dedicatedPiExtension).toBe('function');
  });

  it('loads a fresh synchronized bootstrap dynamically', async () => {
    const { directory, bootstrap } = bootstrapModule(
      "import fs from 'node:fs';\nexport default function () { fs.writeFileSync(new URL('./loaded', import.meta.url), 'yes'); }\n",
    );
    findSyncedRoot.mockReturnValue(syncedRoot());
    readStartupBootstrapStatus.mockReturnValue({ bootstrap, fresh: true });

    try {
      await doomPiPackageExtension(pi);

      expect(fs.readFileSync(path.join(directory, 'loaded'), 'utf8')).toBe('yes');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed with the stable sync warning when synchronized output is missing', async () => {
    findSyncedRoot.mockReturnValue(syncedRoot());
    readStartupBootstrapStatus.mockReturnValue({ bootstrap: undefined, fresh: false });

    await doomPiPackageExtension(pi);

    const registrations = (
      pi.on as unknown as {
        mock: {
          calls: Array<
            [string, (event: unknown, context: { ui: { notify: (message: string, level: string) => void } }) => unknown]
          >;
        };
      }
    ).mock.calls;
    const registration = registrations.find(([event]) => event === 'session_start');
    expect(registration).toBeDefined();
    const notify = vi.fn();
    await registration?.[1]({}, { ui: { notify } });
    expect(notify).toHaveBeenCalledWith('doompi could not read its synchronized state. Run doompi sync.', 'warning');
  });

  it('stays inert when Pi is outside a synchronized repository', async () => {
    findSyncedRoot.mockReturnValue(undefined);

    await doomPiPackageExtension(pi);

    expect(readStartupBootstrapStatus).not.toHaveBeenCalled();
  });

  it('rejects a generated bootstrap without a default factory', async () => {
    const { directory, bootstrap } = bootstrapModule('export const invalid = true;\n');
    findSyncedRoot.mockReturnValue(syncedRoot());
    readStartupBootstrapStatus.mockReturnValue({ bootstrap, fresh: true });

    try {
      await expect(doomPiPackageExtension(pi)).rejects.toThrow(
        `DoomPi bootstrap does not export an extension factory: ${bootstrap}`,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
