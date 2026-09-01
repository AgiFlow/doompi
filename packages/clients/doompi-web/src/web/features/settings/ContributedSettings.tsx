import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import type { SettingsFieldContribution, SettingsSectionContribution } from '@agimon-ai/doompi-web-contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SettingsConfigView,
  SettingsModel,
  SettingsOrigin,
  SettingsScope,
  SettingsValueView,
} from '../../../types/settings.ts';
import { listSettingsModels, readSettingsConfig, writeSettingsValue } from '../../lib/settingsApi.ts';
import {
  canSaveSettings,
  plannedSettingsWrites,
  settingsKeyOf as keyOf,
  settingsLockedReason as lockedReason,
} from '../../lib/settingsDraft.ts';
import { refreshSessionFacts } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

/**
 * A settings page a package contributed, rendered by the host.
 *
 * The host draws these rather than the package because the hard part is not
 * the form, it is which file an edit lands in. `.doom/config.yaml` exists
 * globally and per repository, the merge picks a winner per field, and some
 * keys are only ever read from one side. A page that got that wrong would
 * write bytes the runtime then ignores, which looks exactly like nothing
 * happening. So scope is the workspace the page is opened in, once, and every
 * contributed field inherits it.
 *
 * Edits are held as drafts until Save. A settings page is read as much as it is
 * written, and a control that committed on every keystroke or menu pick would
 * write a config file while someone was still deciding.
 */

/** The select entry that clears a key, since unset is how the file spells "inherit". */
const INHERIT_VALUE = '__inherit__';

const ORIGIN_LABEL: Readonly<Record<SettingsOrigin, string>> = {
  global: 'from global',
  repository: 'overridden here',
  default: 'default',
};

function OriginBadge({ origin, scope }: { origin: SettingsOrigin; scope: SettingsScope }) {
  // An override the reader is not currently editing is the one thing worth
  // colouring: it is why an edit at the other scope would appear to do nothing.
  const shadowed = origin === 'repository' && scope === 'global';
  return (
    <Badge tone={shadowed ? 'yellow' : 'neutral'} className="shrink-0 text-[8px]">
      {ORIGIN_LABEL[origin]}
    </Badge>
  );
}

interface FieldRowProps {
  field: SettingsFieldContribution;
  view: SettingsValueView | undefined;
  scope: SettingsScope;
  models: readonly SettingsModel[];
  /** The pending edit, or undefined when the field is untouched. */
  draft: string | null | undefined;
  busy: boolean;
  onDraft: (field: SettingsFieldContribution, value: string | null | undefined) => void;
}

function FieldRow({ field, view, scope, models, draft, busy, onDraft }: FieldRowProps) {
  const locked = lockedReason(view, scope);
  const dirty = draft !== undefined;
  // A cleared draft is null; an untouched field falls back to what is on disk.
  const value = draft === undefined ? (view?.value ?? '') : (draft ?? '');
  const options = useMemo(() => {
    if (field.optionsFrom !== 'models') return field.options ?? [];
    return models.map((model) => ({
      value: model.value,
      label: model.label,
      group: model.group,
    }));
  }, [field.options, field.optionsFrom, models]);
  const groups = useMemo(() => [...new Set(options.map((option) => option.group ?? ''))], [options]);
  // A select with nothing to offer is a dead control, so it degrades to text
  // rather than showing an empty menu the reader cannot get past.
  const kind = field.kind === 'select' && options.length === 0 ? 'text' : field.kind;

  return (
    <div data-testid={`settings-field-${field.id}`} data-dirty={dirty} className="flex flex-col gap-1 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-doom-hi">{field.label}</span>
        {dirty ? (
          <Badge tone="cyan" data-testid={`settings-dirty-${field.id}`} className="shrink-0 text-[8px]">
            unsaved
          </Badge>
        ) : null}
        {view === undefined ? null : <OriginBadge origin={view.origin} scope={scope} />}
        {locked === undefined ? null : (
          <Badge tone="neutral" data-testid={`settings-locked-${field.id}`} className="shrink-0 text-[8px]">
            {locked}
          </Badge>
        )}
      </div>

      {kind === 'info' ? (
        <span className="text-[11px] text-doom-text">{value || '—'}</span>
      ) : kind === 'select' ? (
        <Select
          value={value === '' ? INHERIT_VALUE : value}
          disabled={busy || locked !== undefined}
          onValueChange={(next) => onDraft(field, next === INHERIT_VALUE ? null : next)}
        >
          <SelectTrigger data-testid={`settings-select-${field.id}`} className="text-[11px]">
            <SelectValue placeholder={field.placeholder ?? 'inherit'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>{field.placeholder ?? 'inherit'}</SelectItem>
            {groups.map((group) => (
              <SelectGroup key={group}>
                {group === '' ? null : <SelectLabel>{group}</SelectLabel>}
                {options
                  .filter((option) => (option.group ?? '') === group)
                  .map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          data-testid={`settings-input-${field.id}`}
          value={value}
          spellCheck={false}
          disabled={busy || locked !== undefined}
          placeholder={field.placeholder ?? 'inherit'}
          // A blank field means "inherit": the parser rejects an empty value, so
          // clearing the key is how the file spells it.
          onChange={(event) => onDraft(field, event.target.value === '' ? null : event.target.value)}
          className="text-[11px]"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {field.detail === undefined ? null : (
          <span className="min-w-0 basis-full text-[9px] leading-relaxed text-doom-faint min-[480px]:basis-auto min-[480px]:flex-1">
            {field.detail}
          </span>
        )}
        <span className="min-w-0 break-all text-[9px] text-doom-faint/70 min-[480px]:shrink-0">{keyOf(field)}</span>
        {dirty ? (
          <Button
            variant="ghost"
            size="xs"
            data-testid={`settings-revert-${field.id}`}
            disabled={busy}
            onClick={() => onDraft(field, undefined)}
            className="shrink-0 text-[9px]"
          >
            revert
          </Button>
        ) : view?.origin === scope && locked === undefined ? (
          <Button
            variant="ghost"
            size="xs"
            data-testid={`settings-clear-${field.id}`}
            disabled={busy}
            onClick={() => onDraft(field, null)}
            className="shrink-0 text-[9px]"
          >
            clear override
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface ContributedSettingsProps {
  section: SettingsSectionContribution;
  /** Which config file edits land in; the workspace the page sits in decides it. */
  scope: SettingsScope;
  /** The repository whose config is being edited; empty at global scope. */
  repoRoot?: string;
}

export function ContributedSettings({ section, scope, repoRoot = '' }: ContributedSettingsProps) {
  const [models, setModels] = useState<readonly SettingsModel[]>([]);
  const [config, setConfig] = useState<SettingsConfigView | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const keys = useMemo(() => section.fields.map(keyOf), [section.fields]);
  const wantsModels = useMemo(() => section.fields.some((field) => field.optionsFrom === 'models'), [section.fields]);
  const dirtyFields = useMemo(() => section.fields.filter((field) => keyOf(field) in drafts), [drafts, section.fields]);

  // Drafts belong to the file they were typed against, so switching repository
  // discards them rather than replaying them onto another config. Clearing
  // while rendering the change keeps the stale drafts from painting once more.
  const fileKey = `${scope}\u0000${repoRoot}`;
  const [lastFileKey, setLastFileKey] = useState(fileKey);
  if (lastFileKey !== fileKey) {
    setLastFileKey(fileKey);
    setDrafts({});
    setNote('');
  }
  useEffect(() => {
    if (!wantsModels) return;
    void listSettingsModels().then(setModels);
  }, [wantsModels]);

  // The global file stands on its own, so this runs with or without a
  // repository; only the repository half of the answer depends on one.
  const reload = useCallback(async (): Promise<void> => {
    const result = await readSettingsConfig(repoRoot, keys);
    if (result.ok) {
      setConfig(result.config);
      setError('');
      return;
    }
    setConfig(undefined);
    setError(result.error);
  }, [keys, repoRoot]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- reads the hub's settings config file over HTTP; the state is the response.
    void reload();
  }, [reload]);

  const setDraft = useCallback((field: SettingsFieldContribution, value: string | null | undefined): void => {
    setNote('');
    setDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[keyOf(field)];
      else next[keyOf(field)] = value;
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (config === undefined || !canSaveSettings({ dirty: dirtyFields.length, scope, repoRoot })) return;
    setBusy(true);
    setError('');
    // One request per field, in order, so a refusal names the field that caused
    // it and everything before it has already landed. Each write answers with
    // the file's new hash, which the next one must carry.
    const planned = plannedSettingsWrites({
      fields: section.fields,
      drafts,
      scope,
      repoRoot,
      startingHash: config.hashes[scope],
    });
    let hash = config.hashes[scope];
    let saved = 0;
    for (const [index, write] of planned.entries()) {
      const result = await writeSettingsValue({ ...write, expectedHash: hash });
      if (!result.ok) {
        setError(`${dirtyFields[index]?.label ?? 'setting'}: ${result.error}`);
        break;
      }
      hash = result.config.hashes[scope];
      saved += 1;
    }
    setBusy(false);
    if (saved > 0) {
      setDrafts({});
      setNote(`saved ${String(saved)} ${saved === 1 ? 'setting' : 'settings'}`);
      // Plan mode re-reads this file when it next activates, but the cockpit's
      // own view of each session was built before the change, so it is asked
      // for its facts again rather than left showing the old ones.
      for (const sessionId of Object.keys(sessionsStore.state.byId)) refreshSessionFacts(sessionId);
    }
    await reload();
  }, [config, dirtyFields, drafts, reload, repoRoot, scope, section.fields]);

  const discard = useCallback((): void => {
    setDrafts({});
    setError('');
    setNote('');
  }, []);

  return (
    <div data-testid={`settings-contributed-${section.id}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[12px] font-bold text-doom-hi">{section.label}</span>
          <span className="min-w-0 basis-full text-[10px] leading-relaxed text-doom-faint min-[560px]:basis-auto min-[560px]:flex-1">
            {section.detail}
          </span>
          {scope === 'repository' && repoRoot === '' ? (
            <span data-testid="settings-no-repositories" className="shrink-0 text-[9px] text-doom-faint">
              pick a repository above to edit its config
            </span>
          ) : null}
        </div>
      </header>

      {error === '' ? null : (
        <p data-testid="settings-error" className="text-[11px] leading-relaxed text-doom-red">
          {error}
        </p>
      )}

      <div className="flex flex-col divide-y divide-doom-border">
        {section.fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            view={config?.values[keyOf(field)]}
            scope={scope}
            models={models}
            draft={keyOf(field) in drafts ? drafts[keyOf(field)] : undefined}
            busy={busy}
            onDraft={setDraft}
          />
        ))}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-doom-border pt-3">
        <Button
          variant="outline"
          size="xs"
          data-testid="settings-save"
          loading={busy}
          disabled={busy || !canSaveSettings({ dirty: dirtyFields.length, scope, repoRoot })}
          onClick={() => void save()}
          className="text-[10px]"
        >
          save
        </Button>
        {dirtyFields.length === 0 ? null : (
          <Button
            variant="ghost"
            size="xs"
            data-testid="settings-discard"
            disabled={busy}
            onClick={discard}
            className="text-[10px]"
          >
            discard
          </Button>
        )}
        <span
          data-testid="settings-save-note"
          className="min-w-0 basis-full text-[9px] leading-relaxed text-doom-faint min-[480px]:basis-auto min-[480px]:flex-1"
        >
          {dirtyFields.length > 0
            ? `${String(dirtyFields.length)} unsaved · writing to ${scope === 'global' ? 'the global config' : 'this repository'}`
            : note}
        </span>
      </footer>
    </div>
  );
}
