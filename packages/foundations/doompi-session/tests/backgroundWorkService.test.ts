import {
  DOOM_BACKGROUND_WORK_CHANGED_EVENT,
  readDoomBackgroundWorkService,
} from '@agimon-ai/doompi-core/backgroundWork';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { createBackgroundWorkService, provideBackgroundWorkService } from '../src/services/backgroundWorkService';

const roots: Context[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe('background-work Cordis service', () => {
  it('replaces providers by name and makes stale handles harmless', () => {
    const root = new Context();
    roots.push(root);
    const changed: string[] = [];
    root.on(DOOM_BACKGROUND_WORK_CHANGED_EVENT, (event) => changed.push(event.kind));
    const service = createBackgroundWorkService(root);
    const first = service.register({
      provider: 'task',
      listActiveWork: () => [{ id: 'old', sessionId: 'session-1' }],
    });
    const second = service.register({
      provider: 'task',
      listActiveWork: () => [{ id: 'new', sessionId: 'session-1' }],
    });

    first.dispose();
    second.update();
    expect(service.snapshot('session-1')).toEqual({
      items: [{ provider: 'task', id: 'new', sessionId: 'session-1' }],
      errors: [],
    });
    expect(changed).toEqual(['registered', 'registered', 'updated']);

    second.dispose();
    expect(service.snapshot()).toEqual({ items: [], errors: [] });
    expect(changed.at(-1)).toBe('unregistered');
  });

  it('isolates invalid provider snapshots as named errors', () => {
    const root = new Context();
    roots.push(root);
    const service = createBackgroundWorkService(root);
    service.register({ provider: 'broken', listActiveWork: () => [{ id: '', sessionId: 'session-1' }] });

    expect(service.snapshot()).toEqual({
      items: [],
      errors: [{ provider: 'broken', message: 'listActiveWork() returned an invalid item.' }],
    });
  });

  it('installs the coordinator under the shared Core service key', () => {
    const root = new Context();
    roots.push(root);
    provideBackgroundWorkService(root);

    expect(readDoomBackgroundWorkService(root)?.generation).toMatch(/^doom-background-work:/u);
  });
});
