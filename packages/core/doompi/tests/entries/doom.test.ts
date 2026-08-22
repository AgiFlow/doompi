import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import doomExtension from '../../src/exports/entries/doom';

const acquireCompositionClaim = vi.hoisted(() => vi.fn());
const releaseCompositionClaim = vi.hoisted(() => vi.fn());
const composeDoomSession = vi.hoisted(() => vi.fn());
const cleanupRunDirectory = vi.hoisted(() => vi.fn());
const findSyncedRoot = vi.hoisted(() => vi.fn());
const registerDoomFlags = vi.hoisted(() => vi.fn());

vi.mock('../../src/adapters/composer.ts', () => ({
  composeDoomSession,
  cleanupRunDirectory,
  findSyncedRoot,
  registerDoomFlags,
}));
vi.mock('../../src/adapters/compositionState.ts', () => ({ acquireCompositionClaim }));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function createPi(): { pi: ExtensionAPI; handlers: Map<string, Handler>; notices: Array<[string, string]> } {
  const handlers = new Map<string, Handler>();
  const notices: Array<[string, string]> = [];
  const pi = {
    registerFlag: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  return { pi, handlers, notices };
}

function createContext(cwd: string, notices: Array<[string, string]>): ExtensionContext {
  return {
    cwd,
    ui: { notify: (message: string, level: string) => notices.push([message, level]) },
  } as unknown as ExtensionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  acquireCompositionClaim.mockReturnValue(releaseCompositionClaim);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('doom extension', () => {
  it('stands down when another registration owns this Pi load cycle', async () => {
    acquireCompositionClaim.mockReturnValue(undefined);
    const { pi } = createPi();

    await doomExtension(pi);

    expect(registerDoomFlags).not.toHaveBeenCalled();
    expect(composeDoomSession).not.toHaveBeenCalled();
  });

  it('registers the flags before composing, so Pi accepts them either way', async () => {
    composeDoomSession.mockResolvedValue({ problems: [], stale: false, loaded: [] });
    const { pi } = createPi();

    await doomExtension(pi);

    expect(registerDoomFlags).toHaveBeenCalledWith(pi);
    expect(composeDoomSession).toHaveBeenCalledWith(pi);
  });

  it('reports composition problems once the session can show them', async () => {
    composeDoomSession.mockResolvedValue({ problems: ['--profile ghost: unknown'], stale: false, loaded: [] });
    const { pi, handlers, notices } = createPi();

    await doomExtension(pi);
    await handlers.get('session_start')?.({}, createContext('/repo', notices));

    expect(notices).toEqual([['--profile ghost: unknown', 'warning']]);
    expect(releaseCompositionClaim).toHaveBeenCalledOnce();
  });

  it('prompts for a re-sync when the config moved on', async () => {
    composeDoomSession.mockResolvedValue({ problems: [], stale: true, loaded: [] });
    const { pi, handlers, notices } = createPi();

    await doomExtension(pi);
    await handlers.get('session_start')?.({}, createContext('/repo', notices));

    expect(notices[0]?.[0]).toContain('doompi sync');
  });

  it('removes its session directory on shutdown', async () => {
    composeDoomSession.mockResolvedValue({ problems: [], stale: false, loaded: [] });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-entry-')));
    findSyncedRoot.mockReturnValue(root);
    const { pi, handlers, notices } = createPi();

    await doomExtension(pi);
    await handlers.get('session_shutdown')?.({}, createContext(root, notices));

    expect(cleanupRunDirectory).toHaveBeenCalledWith(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves an unsynced repository alone on shutdown', async () => {
    composeDoomSession.mockResolvedValue({ problems: [], stale: false, loaded: [] });
    findSyncedRoot.mockReturnValue(undefined);
    const { pi, handlers, notices } = createPi();

    await doomExtension(pi);
    await handlers.get('session_shutdown')?.({}, createContext('/elsewhere', notices));

    expect(cleanupRunDirectory).not.toHaveBeenCalled();
  });
});
