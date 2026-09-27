import { workspaceApiPath, type WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  OptionRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import { GIT_API_BASE_PATH, GIT_BRANCHES_PATH, GIT_SESSIONS_PATH } from '../../../../../constants/git';
import type { GitBranchesResponse, GitSessionCreated } from '../../../../../types/gitSessions';
import {
  baseOptions,
  branchOptions,
  createRequest,
  formProblem,
  type NewSessionFormState,
  type NewSessionMode,
} from '../../_lib/newSessionForm';

const MODES: readonly { mode: NewSessionMode; label: string }[] = [
  { mode: 'existing', label: 'existing branch' },
  { mode: 'new', label: 'new branch' },
  { mode: 'plain', label: 'no branch' },
];

function errorOf(body: unknown, status: number): string {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `The cockpit answered ${String(status)}.`;
}

/**
 * The new-session dialog when git is installed: a worktree on an existing or a
 * new branch, or a plain session in the workspace root. A worktree session
 * starts at the top level of the rail, with no parent.
 */
export function GitNewSessionDialog({ newSession }: WebPluginSlotProps) {
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<NewSessionFormState>({ mode: 'existing', newBranch: '', baseRef: '', name: '' });
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const workspaceId = newSession?.workspaceId;
  const request = newSession?.requestWithStepUp;

  useEffect(() => {
    if (workspaceId === undefined || request === undefined) return;
    let stale = false;
    const url = `${workspaceApiPath(workspaceId)}/plugins/${GIT_API_BASE_PATH}${GIT_BRANCHES_PATH}`;
    void request(url)
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => undefined);
        if (stale) return;
        if (!response.ok) {
          setLoadError(errorOf(body, response.status));
          return;
        }
        const loaded = body as GitBranchesResponse;
        setBranches(loaded);
        setForm((current) => ({ ...current, baseRef: loaded.defaultBase ?? '' }));
      })
      .catch(() => {
        if (!stale) setLoadError('The branches could not be loaded.');
      });
    return () => {
      stale = true;
    };
  }, [workspaceId, request]);

  if (newSession === undefined) return null;

  const gitReady = branches?.repository === true && loadError === '';
  const mode: NewSessionMode = gitReady || branches === null ? form.mode : 'plain';
  const state = { ...form, mode };
  const problem = formProblem(state);
  const options = branches === null ? [] : branchOptions(branches, query);
  const bases = branches === null ? [] : baseOptions(branches);
  const update = (patch: Partial<NewSessionFormState>): void => setForm((current) => ({ ...current, ...patch }));

  const submit = async (): Promise<void> => {
    if (busy || problem !== undefined) return;
    setBusy(true);
    setError('');
    const body = createRequest(state);
    let failure: string | undefined;
    if (body === undefined) {
      failure = await newSession.createPlain(state.name);
    } else {
      try {
        const response = await newSession.requestWithStepUp(
          `${workspaceApiPath(newSession.workspaceId)}/plugins/${GIT_API_BASE_PATH}${GIT_SESSIONS_PATH}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        const answer: unknown = await response.json().catch(() => undefined);
        failure = response.ok
          ? await newSession.openCreated((answer as GitSessionCreated).sessionId)
          : errorOf(answer, response.status);
      } catch {
        failure = 'The cockpit is unreachable.';
      }
    }
    if (failure === undefined) return;
    setError(failure);
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && newSession.close()}>
      <DialogContent width="md" data-testid="new-session-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>new session</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="truncate text-xs text-doom-faint" title={newSession.workspaceRoot}>
            {newSession.workspaceRoot}
          </p>
          {gitReady ? (
            <div role="radiogroup" aria-label="session kind" className="flex gap-1">
              {MODES.map((entry) => (
                <Button
                  key={entry.mode}
                  role="radio"
                  aria-checked={mode === entry.mode}
                  variant={mode === entry.mode ? 'outline' : 'ghost'}
                  size="sm"
                  data-testid={`git-new-session-mode-${entry.mode}`}
                  disabled={busy}
                  className={mode === entry.mode ? 'border-doom-blue/60 text-doom-hi' : undefined}
                  onClick={() => update({ mode: entry.mode })}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
          ) : branches === null && loadError === '' ? (
            <p className="text-xs text-doom-faint">reading branches…</p>
          ) : (
            <p data-testid="git-new-session-plain-note" className="text-xs text-doom-faint">
              {loadError || 'This workspace is not a git checkout, so the session starts in its folder.'}
            </p>
          )}

          {mode === 'existing' && gitReady ? (
            <div className="flex flex-col gap-1">
              <Input
                data-testid="git-new-session-branch-search"
                aria-label="find a branch"
                value={query}
                autoFocus
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="find a branch"
              />
              <div
                role="listbox"
                aria-label="branches"
                className="max-h-48 overflow-y-auto rounded border border-doom-border bg-doom-deep p-1"
              >
                {options.length === 0 ? (
                  <p className="px-2 py-1 text-2xs text-doom-faint">no matching branches</p>
                ) : null}
                {options.map((option) => (
                  <OptionRow
                    key={option.key}
                    density="compact"
                    active={form.selected?.key === option.key}
                    disabled={option.busyAt !== undefined || busy}
                    data-testid="git-new-session-branch-option"
                    data-branch={option.name}
                    data-remote={option.remote}
                    onClick={() => update({ selected: option })}
                    className={`w-full px-2.5 py-1 text-sm ${option.busyAt !== undefined ? 'opacity-50' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {option.remote === undefined ? option.name : `${option.remote}/${option.name}`}
                    </span>
                    <span className="shrink-0 text-2xs text-doom-faint">
                      {option.current && option.busyAt !== undefined
                        ? 'current · checked out'
                        : option.current
                          ? 'current'
                          : option.busyAt !== undefined
                            ? 'checked out'
                            : option.remote !== undefined
                              ? 'remote'
                              : ''}
                    </span>
                  </OptionRow>
                ))}
              </div>
            </div>
          ) : null}

          {mode === 'new' && gitReady ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="git-new-session-new-branch" className="flex flex-col gap-1">
                <span className="text-xs text-doom-faint">new branch</span>
                <Input
                  id="git-new-session-new-branch"
                  data-testid="git-new-session-new-branch"
                  value={form.newBranch}
                  autoFocus
                  disabled={busy}
                  onChange={(event) => update({ newBranch: event.target.value })}
                  placeholder="feature/my-change"
                />
              </label>
              <span className="flex flex-col gap-1">
                <span className="text-xs text-doom-faint">from</span>
                <Select value={form.baseRef} onValueChange={(baseRef) => update({ baseRef })} disabled={busy}>
                  <SelectTrigger data-testid="git-new-session-base" aria-label="base branch">
                    <SelectValue placeholder="base branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {bases.map((base) => (
                      <SelectItem key={base} value={base}>
                        {base === branches?.current ? `${base} (current)` : base}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
            </div>
          ) : null}

          <label htmlFor="new-session-name" className="flex flex-col gap-1">
            <span className="text-xs text-doom-faint">
              name{' '}
              <span className="text-doom-faint">(optional{mode === 'plain' ? '' : '; defaults to the branch'})</span>
            </span>
            <Input
              id="new-session-name"
              data-testid="new-session-name"
              value={form.name}
              autoFocus={mode === 'plain'}
              disabled={busy}
              onChange={(event) => update({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="session name"
            />
          </label>
          {error ? (
            <pre
              data-testid="new-session-error"
              className="max-h-28 overflow-y-auto rounded border border-doom-edge-red bg-doom-tint-red/40 px-2.5 py-2 text-xs whitespace-pre-wrap text-doom-red"
            >
              {error}
            </pre>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="new-session-cancel"
              disabled={busy}
              onClick={() => newSession.close()}
            >
              cancel
            </Button>
            <Button
              variant="primary"
              data-testid="new-session-create"
              title={problem}
              disabled={busy || problem !== undefined}
              onClick={() => void submit()}
            >
              {busy ? (mode === 'plain' ? 'creating…' : 'creating worktree…') : 'create'}
            </Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
