import type { RepositorySettingsPanelProps } from '@agimon-ai/doompi-core/web';
/**
 * A workspace's git remote panel: loads that workspace's saved auth and saves a
 * new one. Lives under settings, in the repository section the host scopes.
 *
 * DESIGN PATTERNS:
 * - Per workspace. The host hands the selected repository; its opaque id is
 *   the only thing sent, and the hub resolves it to an admitted root. A
 *   browser never names a path.
 * - Reads through the host's sealed request and writes through its step-up
 *   request, so a remote device proves itself with a passkey before it can
 *   change credentials. The URLs come from the generated client.
 * - After a save the form remounts from what the server returned, which is how
 *   the token field empties and the "token saved" badge appears.
 */
import { EmptyState, Spinner } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import { api } from '../../../../../../generated/client';
import type { GitAuthSaveRequest, GitAuthView } from '../../../../../types/gitAuth';
import { GitAuthForm } from './GitAuthForm';

function isAuthView(value: unknown): value is GitAuthView {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['none', 'ssh', 'https'].includes(String((value as { method?: unknown }).method))
  );
}

function errorOf(body: unknown, status: number): string {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `The cockpit answered ${String(status)}.`;
}

export function GitAuthPanel({ repository, request, requestWithStepUp }: RepositorySettingsPanelProps) {
  const repositoryId = repository?.id;
  const [loaded, setLoaded] = useState<{ repositoryId: string; saved: GitAuthView }>();
  const [loadError, setLoadError] = useState<{ repositoryId: string; error: string }>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [savedNotice, setSavedNotice] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (repositoryId === undefined) return;
    let stale = false;
    request(api.workspace(repositoryId).auth.url({ query: { repositoryId } }))
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => undefined);
        if (stale) return;
        if (response.ok && isAuthView(body)) setLoaded({ repositoryId, saved: body });
        else setLoadError({ repositoryId, error: errorOf(body, response.status) });
      })
      .catch(() => {
        if (!stale) setLoadError({ repositoryId, error: 'The cockpit is unreachable.' });
      });
    return () => {
      stale = true;
    };
  }, [repositoryId, request]);

  if (repository === null || repositoryId === undefined) {
    return (
      <EmptyState
        data-testid="git-auth-no-repository"
        className="py-6"
        title="pick a repository"
        description="git remote auth is set per workspace; choose one above."
      />
    );
  }

  const save = async (next: GitAuthSaveRequest): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);
    setSavedNotice(false);
    try {
      const response = await requestWithStepUp(api.workspace(repositoryId).saveAuth.url({ query: { repositoryId } }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (response.ok && isAuthView(body)) {
        setLoaded({ repositoryId, saved: body });
        setGeneration((current) => current + 1);
        setSavedNotice(true);
      } else {
        setSaveError(errorOf(body, response.status));
      }
    } catch {
      setSaveError('The cockpit is unreachable.');
    } finally {
      setSaving(false);
    }
  };

  if (loadError?.repositoryId === repositoryId) {
    return (
      <p role="alert" data-testid="git-auth-load-error" className="text-xs text-doom-red">
        {loadError.error}
      </p>
    );
  }
  if (loaded?.repositoryId !== repositoryId) {
    return (
      <span data-testid="git-auth-loading" className="flex items-center gap-2">
        <Spinner className="h-3 w-3 text-doom-faint" label="loading git settings" />
        <span className="text-xs text-doom-dim">loading…</span>
      </span>
    );
  }
  return (
    <GitAuthForm
      key={`${repositoryId}-${String(generation)}`}
      saved={loaded.saved}
      saving={saving}
      savedNotice={savedNotice}
      onSave={(next) => void save(next)}
      {...(saveError === undefined ? {} : { saveError })}
    />
  );
}
