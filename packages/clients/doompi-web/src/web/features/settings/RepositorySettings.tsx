import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useCallback, useEffect, useState } from 'react';
import type {
  RepositoryCatalogOption,
  RepositorySelectionChanges,
  RepositorySettingsView,
  SettingsOrigin,
  SettingsRepository,
} from '../../../types/settings.ts';
import { readRepositorySettings, writeRepositorySelection } from '../../lib/settingsApi.ts';
import { refreshSessionFacts } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

/** Repository selection controls shared with package-owned management panels. */

const INHERIT_VALUE = '__inherit__';

const ORIGIN_LABEL: Readonly<Record<SettingsOrigin, string>> = {
  global: 'from global',
  repository: 'overridden here',
  default: 'catalog default',
};

function OriginBadge({ origin }: { origin: SettingsOrigin }) {
  return (
    <Badge tone={origin === 'repository' ? 'cyan' : 'neutral'} className="shrink-0 text-[8px]">
      {ORIGIN_LABEL[origin]}
    </Badge>
  );
}

function optionDetail(options: readonly RepositoryCatalogOption[], name: string | undefined): string {
  if (name === undefined) return '';
  const option = options.find((candidate) => candidate.name === name);
  if (option === undefined) return `Configured value '${name}' is not in the effective catalog.`;
  return option.description ?? (option.layers ? `Layers: ${option.layers.join(', ') || 'none'}.` : '');
}

function hasDraft<K extends keyof RepositorySelectionChanges>(drafts: RepositorySelectionChanges, key: K): boolean {
  return Object.hasOwn(drafts, key);
}

interface SingleAxisProps {
  id: 'major-mode' | 'profile';
  label: string;
  detail: string;
  options: readonly RepositoryCatalogOption[];
  effective: string | undefined;
  repositoryValue: string | undefined;
  origin: SettingsOrigin;
  draft: string | null | undefined;
  dirty: boolean;
  busy: boolean;
  onChange: (value: string | null) => void;
  onRevert: () => void;
}

function SingleAxis({
  id,
  label,
  detail,
  options,
  effective,
  repositoryValue,
  origin,
  draft,
  dirty,
  busy,
  onChange,
  onRevert,
}: SingleAxisProps) {
  const value = dirty ? draft : repositoryValue;
  const selected = value === null || value === undefined ? INHERIT_VALUE : value;
  const inherited = effective === undefined ? 'inherit · none' : `inherit · ${effective}`;
  const shown = value === null || value === undefined ? effective : value;
  return (
    <div data-testid={`repository-axis-${id}`} data-dirty={dirty} className="flex flex-col gap-1.5 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] font-bold text-doom-hi">{label}</span>
        {dirty ? (
          <Badge tone="cyan" className="text-[8px]">
            unsaved
          </Badge>
        ) : null}
        <OriginBadge origin={origin} />
      </div>
      <Select value={selected} disabled={busy} onValueChange={(next) => onChange(next === INHERIT_VALUE ? null : next)}>
        <SelectTrigger data-testid={`repository-select-${id}`} className="text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>{inherited}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.name} value={option.name}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex min-w-0 flex-col items-stretch gap-1.5 min-[480px]:flex-row min-[480px]:items-start min-[480px]:gap-2">
        <span className="min-w-0 flex-1 text-[9px] leading-relaxed text-doom-faint">
          {optionDetail(options, shown) || detail}
        </span>
        {dirty ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={onRevert}
            className="self-end text-[9px] min-[480px]:shrink-0 min-[480px]:self-auto"
          >
            revert
          </Button>
        ) : origin === 'repository' ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => onChange(null)}
            className="self-end text-[9px] min-[480px]:shrink-0 min-[480px]:self-auto"
          >
            clear override
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface DomainsAxisProps {
  view: RepositorySettingsView;
  draft: readonly string[] | null | undefined;
  dirty: boolean;
  busy: boolean;
  onChange: (value: readonly string[] | null) => void;
  onRevert: () => void;
}

function DomainsAxis({ view, draft, dirty, busy, onChange, onRevert }: DomainsAxisProps) {
  const axis = view.selection.domains;
  const inherited = axis.effective ?? [];
  const selected = dirty ? (draft ?? inherited) : (axis.repository ?? inherited);
  const selectedNames = new Set(selected);
  const toggled = (name: string): readonly string[] =>
    selectedNames.has(name) ? selected.filter((entry) => entry !== name) : [...selected, name];

  return (
    <div data-testid="repository-axis-domains" data-dirty={dirty} className="flex flex-col gap-2 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] font-bold text-doom-hi">domains</span>
        {dirty ? (
          <Badge tone="cyan" className="text-[8px]">
            unsaved
          </Badge>
        ) : null}
        <OriginBadge origin={axis.origin} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {view.catalogs.domains.map((domain) => {
          const active = selectedNames.has(domain.name);
          return (
            <Button
              key={domain.name}
              variant={active ? 'outline' : 'ghost'}
              size="xs"
              data-testid={`repository-domain-${domain.name}`}
              data-active={active}
              disabled={busy}
              title={domain.description}
              onClick={() => onChange(toggled(domain.name))}
              className={active ? 'text-[9px] text-doom-blue' : 'text-[9px] text-doom-dim'}
            >
              {domain.name}
            </Button>
          );
        })}
        {view.catalogs.domains.length === 0 ? (
          <span className="text-[10px] text-doom-faint">No domains are configured.</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[9px] text-doom-faint">
          {selected.length === 0 ? 'No domains selected.' : selected.join(', ')}
        </span>
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => onChange([])} className="text-[9px]">
          select none
        </Button>
        {dirty ? (
          <Button variant="ghost" size="xs" disabled={busy} onClick={onRevert} className="text-[9px]">
            revert
          </Button>
        ) : axis.origin === 'repository' ? (
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => onChange(null)} className="text-[9px]">
            clear override
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function RepositorySettings({ repository }: { repository: SettingsRepository | null }) {
  const repositoryId = repository?.id ?? '';
  const [view, setView] = useState<RepositorySettingsView | undefined>();
  const [drafts, setDrafts] = useState<RepositorySelectionChanges>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const dirty = Object.keys(drafts).length;

  const reload = useCallback(async (): Promise<void> => {
    if (repositoryId === '') {
      setView(undefined);
      return;
    }
    const result = await readRepositorySettings(repositoryId);
    if (result.ok) {
      setView(result.settings);
      setError('');
      return;
    }
    setView(undefined);
    setError(result.error);
  }, [repositoryId]);

  // Drafts belong to the repository they were typed against, so switching
  // discards them rather than replaying them onto another repository. Clearing
  // while rendering the change keeps the stale drafts from painting once more.
  const [lastRepositoryId, setLastRepositoryId] = useState(repositoryId);
  if (lastRepositoryId !== repositoryId) {
    setLastRepositoryId(repositoryId);
    setDrafts({});
    setNote('');
  }

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- reads the repository settings over HTTP; the state is the response.
    void reload();
  }, [reload]);

  const change = useCallback(
    <K extends keyof RepositorySelectionChanges>(key: K, value: RepositorySelectionChanges[K]) => {
      setNote('');
      setDrafts((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const revert = useCallback((key: keyof RepositorySelectionChanges) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (view === undefined || dirty === 0) return;
    setBusy(true);
    setError('');
    const result = await writeRepositorySelection({
      repositoryId: view.repository.id,
      expectedHash: view.hash,
      changes: drafts,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      await reload();
      return;
    }
    setView(result.settings);
    setDrafts({});
    setNote('Repository defaults saved. Run doompi sync before starting the next session.');
    for (const sessionId of Object.keys(sessionsStore.state.byId)) refreshSessionFacts(sessionId);
  }, [dirty, drafts, reload, view]);

  const modeDirty = hasDraft(drafts, 'majorMode');
  const domainDirty = hasDraft(drafts, 'domains');
  const profileDirty = hasDraft(drafts, 'profile');

  return (
    <div data-testid="repository-settings" className="flex flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[12px] font-bold text-doom-hi">defaults</span>
        <span className="min-w-0 flex-1 text-[10px] text-doom-faint">
          Selection defaults apply to the next synced session. Open sessions keep their current composition.
        </span>
      </header>

      {repository === null ? (
        <p data-testid="repository-settings-empty" className="text-[11px] text-doom-faint">
          Open a session inside a .doom or Git repository to configure it here.
        </p>
      ) : null}

      {error === '' ? null : (
        <p data-testid="repository-settings-error" className="text-[11px] text-doom-red">
          {error}
        </p>
      )}

      {view === undefined ? null : (
        <section className="flex flex-col divide-y divide-doom-border rounded-md border border-doom-border px-2.5 sm:px-3">
          <SingleAxis
            id="major-mode"
            label="major mode"
            detail="The extension and package layer composition used by default."
            options={view.catalogs.majorModes}
            effective={view.selection.majorMode.effective}
            repositoryValue={view.selection.majorMode.repository}
            origin={view.selection.majorMode.origin}
            draft={modeDirty ? drafts.majorMode : undefined}
            dirty={modeDirty}
            busy={busy}
            onChange={(value) => change('majorMode', value)}
            onRevert={() => revert('majorMode')}
          />
          <DomainsAxis
            view={view}
            draft={domainDirty ? drafts.domains : undefined}
            dirty={domainDirty}
            busy={busy}
            onChange={(value) => change('domains', value)}
            onRevert={() => revert('domains')}
          />
          <SingleAxis
            id="profile"
            label="profile"
            detail="The persona applied when the repository starts a new session."
            options={view.catalogs.profiles}
            effective={view.selection.profile.effective}
            repositoryValue={view.selection.profile.repository}
            origin={view.selection.profile.origin}
            draft={profileDirty ? drafts.profile : undefined}
            dirty={profileDirty}
            busy={busy}
            onChange={(value) => change('profile', value)}
            onRevert={() => revert('profile')}
          />
          <footer className="flex flex-wrap items-center gap-2 py-3">
            <Button
              variant="outline"
              size="xs"
              data-testid="repository-settings-save"
              loading={busy}
              disabled={busy || dirty === 0}
              onClick={() => void save()}
              className="text-[10px]"
            >
              save defaults
            </Button>
            {dirty === 0 ? null : (
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => setDrafts({})} className="text-[10px]">
                discard
              </Button>
            )}
            <span className="min-w-0 basis-full text-[9px] text-doom-faint min-[480px]:basis-auto min-[480px]:flex-1">
              {dirty > 0 ? `${String(dirty)} unsaved ${dirty === 1 ? 'axis' : 'axes'}` : note}
            </span>
          </footer>
        </section>
      )}
    </div>
  );
}
