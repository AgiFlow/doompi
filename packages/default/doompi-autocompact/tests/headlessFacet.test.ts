import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import type {
  DoomHeadlessActivity,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autocompactServerFacet as autocompactHeadlessFacet } from '../src/extensions/server';

function contextFor(host: DoomHeadlessHostService): Context {
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  return context;
}
let root: string;
const SECRET = 'synthetic-autocompact-config-secret';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-autocompact-headless-'));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
  fs.mkdirSync(path.join(root, '.doom'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(cwd = root) {
  const resources: DoomHeadlessResource[] = [];
  const host = {
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return { dispose: vi.fn() };
    },
    registerHook: () => ({ dispose: vi.fn() }),
    registerActivity: () => ({ dispose: vi.fn() }),
  } as unknown as DoomHeadlessHostService;
  await autocompactHeadlessFacet.apply(contextFor(host));
  const resource = resources.find(({ name }) => name === 'doompi/autocompact-config');
  if (!resource) throw new Error('Autocompact resource was not registered');
  const execution: DoomHeadlessExecutionContext = {
    cwd,
    repoRoot: root,
    sessionId: 'autocompact-test',
    environment: {},
    selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    shutdown: vi.fn(),
  };
  return () => resource.read(execution);
}

function config(enabled: boolean): void {
  fs.writeFileSync(
    path.join(root, '.doom/config.yaml'),
    `# API_TOKEN=${SECRET}\nmodes:\n  autocompact:\n    enabled: ${enabled}\n    thresholds:\n      pass1: 0.4\n  planning:\n    subagents:\n      model: fixture/private-planning-model\n`,
  );
}

describe('autocompact headless configuration projection', () => {
  it('projects only validated owned settings and re-reads changes without exposing raw configuration', async () => {
    config(false);
    const read = await fixture();
    const first = await read();
    expect(first).not.toContain(SECRET);
    expect(first).not.toContain('private-planning-model');
    expect(JSON.parse(first)).toEqual({ enabled: false, thresholds: { pass1: 0.4 } });
    config(true);
    expect(JSON.parse(await read())).toEqual({ enabled: true, thresholds: { pass1: 0.4 } });
  });

  it('uses the admitted repository rather than a different working directory', async () => {
    config(false);
    expect(JSON.parse(await (await fixture(path.join(root, 'nested-working-directory')))())).toEqual({
      enabled: false,
      thresholds: { pass1: 0.4 },
    });
  });

  it('returns empty settings when absent and rejects malformed settings without a raw fallback', async () => {
    const read = await fixture();
    expect(JSON.parse(await read())).toEqual({});
    fs.writeFileSync(
      path.join(root, '.doom/config.yaml'),
      'modes:\n  autocompact:\n    thresholds:\n      pass1: invalid\n',
    );
    await expect(Promise.resolve().then(read)).rejects.toThrow();
  });

  it.each([
    [true, 'native fallback'],
    [false, undefined],
  ] as const)('leaves native compaction enabled when configured enabled=%s', async (enabled, expectedStatus) => {
    config(enabled);
    const activities: DoomHeadlessActivity[] = [];
    const registerHook = vi.fn();
    const host = {
      registerResource: () => ({ dispose: vi.fn() }),
      registerHook,
      registerActivity: (activity: DoomHeadlessActivity) => {
        activities.push(activity);
        return { dispose: vi.fn() };
      },
    } as unknown as DoomHeadlessHostService;
    await autocompactHeadlessFacet.apply(contextFor(host));
    const activity = activities.find(({ name }) => name === 'doompi-autocompact');
    if (!activity) throw new Error('Autocompact activity was not registered');
    const setStatus = vi.fn();
    const compact = vi.fn();
    const execution = {
      cwd: root,
      repoRoot: root,
      sessionId: 'autocompact-test',
      environment: {},
      selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
      client: { notify: vi.fn(), request: vi.fn(), setStatus },
      session: {
        entries: () => [],
        appendCustomEntry: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        compact,
        activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
      },
      shutdown: vi.fn(),
    } as DoomHeadlessExecutionContext;

    const stop = await activity.start(execution);
    expect(registerHook).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('doom-autocompact', expectedStatus);
    await stop();
    expect(setStatus).toHaveBeenLastCalledWith('doom-autocompact', undefined);
  });
});
