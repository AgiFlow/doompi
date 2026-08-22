import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  DPI_MANAGED_SETTINGS,
  type DpiSettingsScope,
  DpiSettingsStorage,
  type DpiSettingsStorageBackend,
  installDpiSettingsOverlay,
  type PiSettingsRuntime,
} from '../../src/adapters/dpiSettings.ts';

class MemorySettingsStorage implements DpiSettingsStorageBackend {
  global: string | undefined;
  project: string | undefined;

  constructor(global?: Record<string, unknown>, project?: Record<string, unknown>) {
    this.global = global ? JSON.stringify(global) : undefined;
    this.project = project ? JSON.stringify(project) : undefined;
  }

  withLock(scope: DpiSettingsScope, callback: (current: string | undefined) => string | undefined): void {
    const next = callback(scope === 'global' ? this.global : this.project);
    if (next === undefined) return;
    if (scope === 'global') this.global = next;
    else this.project = next;
  }
}

function readScope(storage: DpiSettingsStorage, scope: DpiSettingsScope): Record<string, unknown> | undefined {
  let content: string | undefined;
  storage.withLock(scope, (current) => {
    content = current;
    return undefined;
  });
  return content ? (JSON.parse(content) as Record<string, unknown>) : undefined;
}

describe('DpiSettingsStorage', () => {
  it('overlays DoomPi values globally and hides project attempts to replace them', () => {
    const backend = new MemorySettingsStorage(
      { defaultModel: 'global-model', theme: 'user-theme' },
      { defaultProvider: 'project-provider', extensions: ['./project.ts'] },
    );
    const storage = new DpiSettingsStorage(backend);

    expect(readScope(storage, 'global')).toEqual({
      defaultModel: 'global-model',
      theme: DPI_MANAGED_SETTINGS.theme,
      extensions: DPI_MANAGED_SETTINGS.extensions,
      themes: DPI_MANAGED_SETTINGS.themes,
      quietStartup: true,
    });
    expect(readScope(storage, 'project')).toEqual({ defaultProvider: 'project-provider' });
  });

  it('persists unrelated edits without writing the embedded defaults', () => {
    const backend = new MemorySettingsStorage({ defaultModel: 'before' });
    const storage = new DpiSettingsStorage(backend);

    storage.withLock('global', (current) => {
      const settings = JSON.parse(current ?? '{}') as Record<string, unknown>;
      settings.defaultModel = 'after';
      settings.theme = 'temporary-choice';
      return JSON.stringify(settings);
    });

    expect(JSON.parse(backend.global ?? '{}')).toEqual({ defaultModel: 'after' });
  });

  it('preserves pre-existing managed values verbatim when Pi saves another setting', () => {
    const backend = new MemorySettingsStorage({
      defaultProvider: 'before',
      extensions: ['./user-extension.ts'],
      theme: 'user-theme',
    });
    const storage = new DpiSettingsStorage(backend);

    storage.withLock('global', (current) => {
      const settings = JSON.parse(current ?? '{}') as Record<string, unknown>;
      settings.defaultProvider = 'after';
      return JSON.stringify(settings);
    });

    expect(JSON.parse(backend.global ?? '{}')).toEqual({
      defaultProvider: 'after',
      extensions: ['./user-extension.ts'],
      theme: 'user-theme',
    });
  });

  it('lets Pi merge unrelated global and project settings around the overlay', async () => {
    const backend = new MemorySettingsStorage(
      { defaultProvider: 'anthropic', theme: 'global-theme' },
      { defaultModel: 'project-model', theme: 'project-theme' },
    );
    const manager = SettingsManager.fromStorage(new DpiSettingsStorage(backend), { projectTrusted: true });

    expect(manager.getDefaultProvider()).toBe('anthropic');
    expect(manager.getDefaultModel()).toBe('project-model');
    expect(manager.getTheme()).toBe('doom-pi-dark');
    expect(manager.getGlobalSettings().extensions).toEqual(DPI_MANAGED_SETTINGS.extensions);
    expect(manager.getProjectSettings().theme).toBeUndefined();

    manager.setDefaultProvider('openai');
    await manager.flush();
    expect(JSON.parse(backend.global ?? '{}')).toEqual({
      defaultProvider: 'openai',
      theme: 'global-theme',
    });
  });

  it('rejects non-object settings with the same load failure shape as Pi', () => {
    const backend = new MemorySettingsStorage();
    backend.global = '[]';
    const storage = new DpiSettingsStorage(backend);

    expect(() => readScope(storage, 'global')).toThrow('Pi settings must contain a JSON object');
  });
});

describe('installDpiSettingsOverlay', () => {
  it('wraps each manager creation and restores the original factory', () => {
    const originalManager = { source: 'original' };
    const wrappedManager = { source: 'wrapped' };
    const originalCreate = vi.fn(() => originalManager);
    const fromStorage = vi.fn(() => wrappedManager);
    const fileStorage = vi.fn(function FileStorage() {
      return new MemorySettingsStorage();
    });
    const runtime = {
      FileSettingsStorage: fileStorage,
      SettingsManager: { create: originalCreate, fromStorage },
    } as unknown as PiSettingsRuntime;

    const restore = installDpiSettingsOverlay(runtime, { PI_CODING_AGENT_DIR: '/agent' });
    expect(runtime.SettingsManager.create('/repo')).toBe(wrappedManager);
    expect(fileStorage).toHaveBeenCalledWith('/repo', '/agent');
    expect(fromStorage).toHaveBeenCalledWith(expect.any(DpiSettingsStorage), undefined);

    restore();
    expect(runtime.SettingsManager.create).toBe(originalCreate);
  });
});
