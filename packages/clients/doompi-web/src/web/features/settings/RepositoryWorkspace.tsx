import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useMemo, useState } from 'react';
import type { SettingsRepository } from '../../../types/settings.ts';
import { listSettingsRepositories } from '../../lib/settingsApi.ts';
import type { SettingsSection } from '../../lib/settingsSections.ts';
import { sealedHttpSession } from '../../lib/sealedSession.ts';
import { fetchWithStepUp } from '../../lib/stepUp.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';
import { RepositorySettings } from './RepositorySettings.tsx';
import { SettingsMenu } from './SettingsMenu.tsx';

const LAST_REPOSITORY_KEY = 'doompi.settings.repository';

const requestThroughSealedSession = (input: string, init?: RequestInit): Promise<Response> =>
  sealedHttpSession.fetch(input, init);

function rememberedRepository(): string {
  try {
    return localStorage.getItem(LAST_REPOSITORY_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberRepository(repositoryId: string): void {
  try {
    localStorage.setItem(LAST_REPOSITORY_KEY, repositoryId);
  } catch {
    // Browser storage is optional. The picker still works for this page load.
  }
}

export function RepositoryWorkspace({ current }: { current: SettingsSection }) {
  const sessionFingerprint = useStore(sessionsStore, (state) => Object.keys(state.byId).sort().join('\n'));
  const [repositories, setRepositories] = useState<readonly SettingsRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState(rememberedRepository);
  const [loading, setLoading] = useState(false);
  const repository = useMemo(
    () => repositories.find((candidate) => candidate.id === repositoryId) ?? null,
    [repositories, repositoryId],
  );

  useEffect(() => {
    let currentRequest = true;
    setLoading(true);
    void listSettingsRepositories().then((found) => {
      if (!currentRequest) return;
      setRepositories(found);
      setRepositoryId((selected) => {
        const next = found.some((candidate) => candidate.id === selected)
          ? selected
          : (found.find((candidate) => candidate.active)?.id ?? found[0]?.id ?? '');
        if (next) rememberRepository(next);
        return next;
      });
      setLoading(false);
    });
    return () => {
      currentRequest = false;
    };
  }, [sessionFingerprint]);

  const selectRepository = (next: string): void => {
    setRepositoryId(next);
    rememberRepository(next);
  };
  const panel = current.repositoryPanel;
  const Panel = panel?.component;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-doom-border bg-doom-panel px-3 py-2 sm:px-5 lg:px-6">
        <span className="order-1 shrink-0 text-[9px] font-bold text-doom-faint sm:order-none">repository</span>
        <Select value={repositoryId} disabled={loading || repositories.length === 0} onValueChange={selectRepository}>
          <SelectTrigger
            data-testid="repository-workspace-picker"
            className="order-4 w-full text-[10px] sm:order-none sm:w-[min(360px,45vw)]"
          >
            <SelectValue placeholder={loading ? 'loading repositories' : 'pick a repository'} />
          </SelectTrigger>
          <SelectContent>
            {repositories.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.active ? ' · active' : ' · recent'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {repository === null ? null : (
          <Badge className="order-2 sm:order-none" tone={repository.active ? 'green' : 'neutral'}>
            {repository.active ? 'active' : 'recent'}
          </Badge>
        )}
        <span className="order-5 w-full min-w-0 truncate text-[9px] text-doom-faint/70 sm:order-none sm:w-auto sm:flex-1">
          {repository?.path}
        </span>
        <Button
          variant="ghost"
          size="xs"
          loading={loading}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void listSettingsRepositories().then((found) => {
              setRepositories(found);
              setLoading(false);
            });
          }}
          className="order-3 ml-auto text-[9px] sm:order-none sm:ml-0"
        >
          refresh
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <SettingsMenu active={current.id} workspace="repository" />
        <section
          data-testid="settings-content"
          className="min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-5 lg:px-8"
        >
          {current.id === 'repositories' ? <RepositorySettings repository={repository} /> : null}
          {panel === undefined || Panel === undefined ? null : (
            <div className="flex flex-col gap-3" data-testid={`repository-settings-panel-${panel.pluginId}`}>
              <header className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-[12px] font-bold text-doom-hi">{panel.label}</span>
                <span className="min-w-0 basis-full text-[10px] text-doom-faint sm:basis-auto sm:flex-1">
                  {panel.detail}
                </span>
              </header>
              <Panel
                repository={repository}
                request={requestThroughSealedSession}
                requestWithStepUp={fetchWithStepUp}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
