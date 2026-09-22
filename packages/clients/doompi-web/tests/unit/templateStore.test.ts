import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsConfigView } from '../../src/types/settings';
import { readSettingsConfig, writeSettingsValue } from '../../src/web/lib/settingsApi';
import {
  configuredTemplate,
  ensureTemplateConfiguration,
  refreshTemplateConfiguration,
  saveTemplateDefault,
  templateStore,
} from '../../src/web/stores/templateStore';

vi.mock('../../src/web/lib/transport', () => ({ onHubConnected: () => () => {} }));
vi.mock('../../src/web/lib/pluginRegistry', () => ({
  webTemplateCatalog: () => ({ templates: [{ id: 'available' }], diagnostics: [] }),
}));
vi.mock('../../src/web/lib/settingsApi', () => ({ readSettingsConfig: vi.fn(), writeSettingsValue: vi.fn() }));

function config(value = 'available', repoRoot = ''): SettingsConfigView {
  return {
    repoRoot,
    values: { 'web.template': { value, origin: 'global', scope: 'both' } },
    hashes: { global: 'global-hash', repository: 'repo-hash' },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  templateStore.setState(() => ({}));
  vi.mocked(readSettingsConfig).mockResolvedValue({ ok: true, config: config() });
  vi.mocked(writeSettingsValue).mockResolvedValue({ ok: true, config: config() });
});

describe('template configuration cache', () => {
  it('shares initial requests per scope and reuses resolved configuration', async () => {
    let finish!: (value: Awaited<ReturnType<typeof readSettingsConfig>>) => void;
    vi.mocked(readSettingsConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = ensureTemplateConfiguration('one');
    expect(ensureTemplateConfiguration('one')).toBe(first);
    await ensureTemplateConfiguration('two');
    expect(readSettingsConfig).toHaveBeenCalledTimes(2);
    finish({ ok: true, config: config('chosen') });
    await first;
    await ensureTemplateConfiguration('one');
    expect(readSettingsConfig).toHaveBeenCalledTimes(2);
    expect(configuredTemplate(templateStore.state['workspace:one']!)).toBe('chosen');
  });

  it('settles a rejected initial read and permits retry', async () => {
    vi.mocked(readSettingsConfig).mockRejectedValueOnce(new Error('settings disconnected'));
    await ensureTemplateConfiguration();
    expect(templateStore.state.global).toMatchObject({ loading: false, error: 'settings disconnected' });
    await ensureTemplateConfiguration();
    expect(templateStore.state.global).toMatchObject({ loading: false, error: undefined });
    expect(configuredTemplate(templateStore.state.global!)).toBe('available');
  });

  it('keeps independent workspace responses and ignores an older overlapping read', async () => {
    let finish: ((value: Awaited<ReturnType<typeof readSettingsConfig>>) => void) | undefined;
    vi.mocked(readSettingsConfig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stale = refreshTemplateConfiguration('one');
    vi.mocked(readSettingsConfig).mockResolvedValueOnce({ ok: true, config: config('new') });
    await refreshTemplateConfiguration('one');
    finish?.({ ok: true, config: config('old') });
    await stale;
    await refreshTemplateConfiguration('two');
    expect(configuredTemplate(templateStore.state['workspace:one']!)).toBe('new');
    expect(configuredTemplate(templateStore.state['workspace:two']!)).toBe('available');
  });

  it('retains the last good configuration during a network error', async () => {
    await refreshTemplateConfiguration();
    vi.mocked(readSettingsConfig).mockResolvedValueOnce({ ok: false, error: 'offline' });
    await refreshTemplateConfiguration();
    expect(configuredTemplate(templateStore.state.global!)).toBe('available');
    expect(templateStore.state.global?.error).toBe('offline');
  });

  it('uses the existing workspace write API with the read file hash', async () => {
    vi.mocked(readSettingsConfig).mockResolvedValueOnce({ ok: true, config: config('available', '/workspace') });
    await refreshTemplateConfiguration('one');
    expect(await saveTemplateDefault('available', 'one')).toBe(true);
    expect(writeSettingsValue).toHaveBeenCalledWith(
      {
        repoRoot: '/workspace',
        scope: 'repository',
        keyPath: ['web', 'template'],
        value: 'available',
        expectedHash: 'repo-hash',
      },
      'one',
    );
  });

  it('refuses a withdrawn template and never retries a conflicting write', async () => {
    await refreshTemplateConfiguration();
    expect(await saveTemplateDefault('missing')).toBe(false);
    expect(writeSettingsValue).not.toHaveBeenCalled();
    vi.mocked(writeSettingsValue).mockResolvedValueOnce({ ok: false, stale: true, error: 'Config changed' });
    expect(await saveTemplateDefault('available')).toBe(false);
    expect(writeSettingsValue).toHaveBeenCalledTimes(1);
    expect(templateStore.state.global?.error).toBe('Config changed');
  });

  it('clears a default with null and refreshes inherited workspace configurations', async () => {
    await refreshTemplateConfiguration();
    await refreshTemplateConfiguration('one');
    expect(await saveTemplateDefault(null)).toBe(true);
    expect(writeSettingsValue).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', value: null, expectedHash: 'global-hash' }),
      undefined,
    );
    expect(readSettingsConfig).toHaveBeenLastCalledWith('', ['web.template'], 'one');
  });
});
