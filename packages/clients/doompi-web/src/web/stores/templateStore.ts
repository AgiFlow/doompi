import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import { useEffect } from 'react';

import type { SettingsConfigView } from '../../types/settings';
import { webTemplateCatalog } from '../lib/pluginRegistry';
import { readSettingsConfig, writeSettingsValue } from '../lib/settingsApi';
import { onHubConnected } from '../lib/transport';

export interface TemplateConfiguration {
  config?: SettingsConfigView;
  error?: string;
  loading: boolean;
  saving: boolean;
}

const EMPTY: TemplateConfiguration = { loading: true, saving: false };
const GLOBAL = 'global';
const KEY = 'web.template';
const requests = new Map<string, number>();
const pendingRequests = new Map<string, Promise<void>>();

/** Preferences belong to Doom config; this store caches only scoped API responses. */
export const templateStore = new Store<Record<string, TemplateConfiguration>>({});

function scopeKey(workspaceId?: string): string {
  return workspaceId === undefined ? GLOBAL : `workspace:${workspaceId}`;
}

function patch(key: string, update: Partial<TemplateConfiguration>): void {
  templateStore.setState((state) => ({ ...state, [key]: { ...(state[key] ?? EMPTY), ...update } }));
}

export function refreshTemplateConfiguration(workspaceId?: string): Promise<void> {
  const key = scopeKey(workspaceId);
  const request = (requests.get(key) ?? 0) + 1;
  requests.set(key, request);
  patch(key, { loading: true, error: undefined });
  const pending = (async () => {
    try {
      const result = await readSettingsConfig('', [KEY], workspaceId);
      if (requests.get(key) !== request) return;
      if (result.ok) patch(key, { config: result.config, loading: false, error: undefined });
      else patch(key, { loading: false, error: result.error });
    } catch (error) {
      if (requests.get(key) === request)
        patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (requests.get(key) === request) pendingRequests.delete(key);
    }
  })();
  pendingRequests.set(key, pending);
  return pending;
}

/** Initial consumers share a read and reuse resolved config; explicit refreshes can supersede it. */
export function ensureTemplateConfiguration(workspaceId?: string): Promise<void> {
  const key = scopeKey(workspaceId);
  return (
    pendingRequests.get(key) ??
    (templateStore.state[key]?.config === undefined ? refreshTemplateConfiguration(workspaceId) : Promise.resolve())
  );
}

export function useTemplateConfiguration(workspaceId?: string): TemplateConfiguration {
  const key = scopeKey(workspaceId);
  const entry = useStore(templateStore, (state) => state[key] ?? EMPTY);
  useEffect(() => {
    void ensureTemplateConfiguration(workspaceId);
    return onHubConnected(() => {
      void (pendingRequests.get(key) ?? refreshTemplateConfiguration(workspaceId));
    });
  }, [key, workspaceId]);
  return entry;
}

/** Refuse unavailable choices before attempting the existing authorized, hash-checked write. */
export async function saveTemplateDefault(id: string | null, workspaceId?: string): Promise<boolean> {
  const key = scopeKey(workspaceId);
  const entry = templateStore.state[key];
  if (entry?.saving) return false;
  if (entry?.config === undefined) {
    patch(key, { error: 'Load the configuration before saving a template default.' });
    return false;
  }
  const mount = workspaceId === undefined ? { scope: 'global' as const } : { scope: 'workspace' as const, workspaceId };
  if (id !== null && !webTemplateCatalog(mount).templates.some((template) => template.id === id)) {
    patch(key, { error: 'That template is no longer available in this composition.' });
    return false;
  }
  const scope = workspaceId === undefined ? 'global' : 'repository';
  patch(key, { saving: true, error: undefined });
  const result = await writeSettingsValue(
    {
      repoRoot: entry.config.repoRoot,
      scope,
      keyPath: ['web', 'template'],
      value: id,
      expectedHash: entry.config.hashes[scope],
    },
    workspaceId,
  );
  if (!result.ok) {
    // Keep the conflict visible. A reload is explicit, never an automatic overwrite.
    patch(key, { saving: false, error: result.error });
    return false;
  }
  requests.set(key, (requests.get(key) ?? 0) + 1);
  pendingRequests.delete(key);
  patch(key, { config: result.config, saving: false, loading: false, error: undefined });
  // Workspace views may inherit a newly saved global value.
  if (workspaceId === undefined) {
    await Promise.all(
      Object.keys(templateStore.state)
        .filter((cached) => cached.startsWith('workspace:'))
        .map((cached) => refreshTemplateConfiguration(cached.slice('workspace:'.length))),
    );
  }
  return true;
}

export function configuredTemplate(entry: TemplateConfiguration): string | undefined {
  return entry.config?.values[KEY]?.value;
}
