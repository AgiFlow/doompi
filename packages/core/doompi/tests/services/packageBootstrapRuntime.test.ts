import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSyncedRoot: vi.fn(),
  readStartupBootstrapStatus: vi.fn(),
  acquireBootstrapClaim: vi.fn(),
}));

vi.mock('../../src/adapters/bootstrapLocator.ts', () => ({
  findSyncedRoot: mocks.findSyncedRoot,
  readStartupBootstrapStatus: mocks.readStartupBootstrapStatus,
}));
vi.mock('../../src/adapters/bootstrapClaim.ts', () => ({
  acquireBootstrapClaim: mocks.acquireBootstrapClaim,
}));

import { packageBootstrap } from '../../src/adapters/packageBootstrap.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-package-runtime-')));
let sequence = 0;

function extensionArtifact(): string {
  sequence += 1;
  const artifact = path.join(root, `bootstrap-${String(sequence)}.mjs`);
  fs.writeFileSync(
    artifact,
    "export default (pi) => pi.registerFlag('doom-loaded', { type: 'boolean', description: 'test' });\n",
  );
  return artifact;
}

/**
 * A Pi API stub that keeps the handlers the bootstrap registers.
 *
 * `start` fires them the way Pi does once the session exists, which is when the
 * bootstrap releases its claim and reports anything it could not honour.
 */
function extensionApi() {
  const handlers: Array<(event: unknown, ctx: unknown) => void> = [];
  const notify = vi.fn();
  const api = {
    registerFlag: vi.fn(),
    notify,
    on: vi.fn((_name: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.push(handler);
    }),
  };
  return {
    api,
    start: () => {
      for (const handler of handlers) handler({}, { ui: { notify } });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSyncedRoot.mockReturnValue('/repo');
  mocks.acquireBootstrapClaim.mockImplementation(() => vi.fn());
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('packageBootstrap', () => {
  it('loads a fresh generated bootstrap', async () => {
    const bootstrap = extensionArtifact();
    const { api } = extensionApi();
    mocks.readStartupBootstrapStatus.mockReturnValue({ bootstrap, fresh: true });

    await packageBootstrap(api as never);

    expect(api.registerFlag).toHaveBeenCalledWith('doom-loaded', expect.objectContaining({ type: 'boolean' }));
  });

  it('fails closed when the synchronized bootstrap is missing or stale', async () => {
    const { api, start } = extensionApi();
    mocks.readStartupBootstrapStatus.mockReturnValue({ bootstrap: undefined, fresh: false });

    await packageBootstrap(api as never);
    start();

    expect(api.registerFlag).not.toHaveBeenCalled();
    expect(api.notify).toHaveBeenCalledWith(
      'doompi could not read its synchronized state. Run doompi sync.',
      'warning',
    );
  });

  it('stays inert outside synchronized repositories', async () => {
    mocks.findSyncedRoot.mockReturnValue(undefined);

    await packageBootstrap({} as never);

    expect(mocks.acquireBootstrapClaim).not.toHaveBeenCalled();
    expect(mocks.readStartupBootstrapStatus).not.toHaveBeenCalled();
  });

  it('stays inert before reading synchronized state when the launcher supplied extensions', async () => {
    vi.stubEnv('DOOMPI_EXTENSIONS_PROVIDED', '1');

    await packageBootstrap({} as never);

    expect(mocks.findSyncedRoot).not.toHaveBeenCalled();
    expect(mocks.acquireBootstrapClaim).not.toHaveBeenCalled();
    expect(mocks.readStartupBootstrapStatus).not.toHaveBeenCalled();
  });

  it('stands down when a sibling install already owns the repository', async () => {
    const { api } = extensionApi();
    mocks.acquireBootstrapClaim.mockReturnValue(undefined);

    await packageBootstrap(api as never);

    expect(mocks.acquireBootstrapClaim).toHaveBeenCalledWith('/repo');
    expect(mocks.readStartupBootstrapStatus).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });

  it('releases the claim so a reload can compose again', async () => {
    const bootstrap = extensionArtifact();
    const release = vi.fn();
    const { api, start } = extensionApi();
    mocks.acquireBootstrapClaim.mockReturnValue(release);
    mocks.readStartupBootstrapStatus.mockReturnValue({ bootstrap, fresh: true });

    await packageBootstrap(api as never);
    expect(release).not.toHaveBeenCalled();

    start();
    expect(release).toHaveBeenCalledOnce();
  });

  it('warns instead of failing the load when the synchronized state is unusable', async () => {
    const release = vi.fn();
    const { api, start } = extensionApi();
    mocks.acquireBootstrapClaim.mockReturnValue(release);
    mocks.readStartupBootstrapStatus.mockImplementation(() => {
      throw new Error('has version 9, expected 8');
    });

    await expect(packageBootstrap(api as never)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();

    start();
    expect(api.notify).toHaveBeenCalledWith(
      'doompi could not read its synchronized state. Run doompi sync.',
      'warning',
    );
  });

  it('reports a thrown non-error value as well', async () => {
    const { api, start } = extensionApi();
    const failure = (function* (): Generator<void, void, unknown> {
      yield undefined;
    })();
    mocks.acquireBootstrapClaim.mockReturnValue(vi.fn());
    mocks.readStartupBootstrapStatus.mockImplementation(() => failure.throw('state.json is a directory'));

    await packageBootstrap(api as never);
    start();

    expect(api.notify).toHaveBeenCalledWith(
      'doompi could not read its synchronized state. Run doompi sync.',
      'warning',
    );
  });

  it('releases the claim when the loaded bootstrap has no factory', async () => {
    const bootstrap = path.join(root, 'bootstrap-no-factory.mjs');
    fs.writeFileSync(bootstrap, 'export const named = 1;\n');
    const release = vi.fn();
    const { api } = extensionApi();
    mocks.acquireBootstrapClaim.mockReturnValue(release);
    mocks.readStartupBootstrapStatus.mockReturnValue({ bootstrap, fresh: true });

    await expect(packageBootstrap(api as never)).rejects.toThrow('does not export an extension factory');
    expect(release).toHaveBeenCalledOnce();
  });
});
