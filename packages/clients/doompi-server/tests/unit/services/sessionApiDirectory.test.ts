import { describe, expect, it, vi } from 'vitest';
import { resolveSessionApiDirectory } from '../../../src/services/sessionApiDirectory.ts';

const SESSION_CWD = '/Users/dev/workspace/vision-capture';
const INSTALLATION_DIR = '/Users/dev/workspace/doompi/node_modules/@agimon-ai/doompi-server/dist/bin';

describe('resolveSessionApiDirectory', () => {
  it('serves the session repository generation when that repository is synced', () => {
    const registeredApiDirectory = vi.fn((from: string) =>
      from === SESSION_CWD ? '/generations/session/api' : undefined,
    );

    expect(
      resolveSessionApiDirectory({ cwd: SESSION_CWD, installationDir: INSTALLATION_DIR, registeredApiDirectory }),
    ).toBe('/generations/session/api');
    expect(registeredApiDirectory).toHaveBeenCalledTimes(1);
  });

  it('inherits the running installation when the session repository was never synced', () => {
    const registeredApiDirectory = vi.fn((from: string) =>
      from === INSTALLATION_DIR ? '/generations/installation/api' : undefined,
    );

    expect(
      resolveSessionApiDirectory({ cwd: SESSION_CWD, installationDir: INSTALLATION_DIR, registeredApiDirectory }),
    ).toBe('/generations/installation/api');
  });

  it('mounts nothing when neither the session repository nor the installation is synced', () => {
    expect(
      resolveSessionApiDirectory({
        cwd: SESSION_CWD,
        installationDir: INSTALLATION_DIR,
        registeredApiDirectory: () => undefined,
      }),
    ).toBeUndefined();
  });
});
