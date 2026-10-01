/**
 * A workspace's git remote panel body: how doompi-git reaches the remote when
 * you pull, push or rebase from this workspace's sessions in the cockpit.
 *
 * DESIGN PATTERNS:
 * - Per workspace. Worktree sessions use the setup of the workspace they
 *   belong to. A workspace with nothing set uses this machine's own git.
 * - Three choices as cards, the way the theme picker offers them: this
 *   machine's own git, an SSH key, or an HTTPS token.
 * - The token is write-only. The field is never prefilled; a saved token shows
 *   as a badge, and leaving the field empty keeps it.
 * - Form state is the reader's until they save. The owner remounts the form
 *   after a save so it starts again from what the server now holds.
 *
 * AVOID:
 * - Echoing a token back. The view the server sends has none to echo.
 */
import {
  AlertIcon,
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupCard,
  ShieldIcon,
  StatusBadge,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { GitAuthMethod, GitAuthSaveRequest, GitAuthView } from '../../../../../types/gitAuth';
import { formFromView, formProblem, saveRequestOf, type GitAuthFormState } from '../_lib/gitAuthForm';

export interface GitAuthFormProps {
  saved: GitAuthView;
  saving: boolean;
  /** Why the last save was refused. */
  saveError?: string;
  /** The last save went through. */
  savedNotice?: boolean;
  onSave: (request: GitAuthSaveRequest) => void;
}

const METHODS: readonly { method: GitAuthMethod; title: string; detail: string }[] = [
  {
    method: 'none',
    title: "this machine's git",
    detail: 'use whatever git on this machine already does: your credential helper, ssh config and agent',
  },
  { method: 'ssh', title: 'SSH key', detail: 'a key file on this machine, or your ssh-agent' },
  { method: 'https', title: 'HTTPS token', detail: 'a username and personal access token for one host' },
];

export function GitAuthForm({ saved, saving, saveError, savedNotice = false, onSave }: GitAuthFormProps) {
  const [form, setForm] = useState<GitAuthFormState>(() => formFromView(saved));
  const update = (patch: Partial<GitAuthFormState>): void => setForm((current) => ({ ...current, ...patch }));
  const problem = formProblem(form, saved);
  const tokenSaved = saved.https?.hasToken === true && saved.https.host === form.host.trim().toLowerCase();

  return (
    <div data-testid="git-auth-form" className="flex w-full min-w-0 flex-col gap-4">
      <RadioGroup
        aria-label="how git reaches your remote"
        value={form.method}
        onValueChange={(value) => update({ method: value as GitAuthMethod })}
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {METHODS.map((choice) => (
          <RadioGroupCard
            key={choice.method}
            value={choice.method}
            data-testid={`git-auth-method-${choice.method}`}
            className="p-3"
          >
            <span className="flex flex-col gap-1">
              <span className="text-sm font-bold text-doom-hi">{choice.title}</span>
              <span className="text-2xs text-doom-dim">{choice.detail}</span>
            </span>
          </RadioGroupCard>
        ))}
      </RadioGroup>

      {form.method === 'ssh' ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-doom-border bg-doom-panel p-3">
          <Label htmlFor="git-auth-key-path" className="text-xs text-doom-hi">
            key path
          </Label>
          <Input
            id="git-auth-key-path"
            data-testid="git-auth-key-path"
            size="sm"
            value={form.keyPath}
            placeholder="~/.ssh/id_ed25519"
            spellCheck={false}
            onChange={(event) => update({ keyPath: event.target.value })}
          />
          <p className="text-2xs text-doom-faint">
            Leave it blank to use your ssh config and ssh-agent. A key with a passphrase works only through ssh-agent.
            An unknown host is refused: run <code className="text-doom-dim">ssh -T git@github.com</code> once in a
            terminal to trust it.
          </p>
        </div>
      ) : null}

      {form.method === 'https' ? (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-doom-border bg-doom-panel p-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-auth-host" className="text-xs text-doom-hi">
              host
            </Label>
            <Input
              id="git-auth-host"
              data-testid="git-auth-host"
              size="sm"
              value={form.host}
              spellCheck={false}
              onChange={(event) => update({ host: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-auth-username" className="text-xs text-doom-hi">
              username
            </Label>
            <Input
              id="git-auth-username"
              data-testid="git-auth-username"
              size="sm"
              value={form.username}
              autoComplete="username"
              spellCheck={false}
              onChange={(event) => update({ username: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="flex items-center gap-2">
              <Label htmlFor="git-auth-token" className="text-xs text-doom-hi">
                token
              </Label>
              {tokenSaved ? (
                <StatusBadge tone="ok" size="xs" data-testid="git-auth-token-saved">
                  token saved
                </StatusBadge>
              ) : null}
            </span>
            <Input
              id="git-auth-token"
              data-testid="git-auth-token"
              size="sm"
              type="password"
              value={form.token}
              autoComplete="new-password"
              placeholder={tokenSaved ? 'leave blank to keep the saved token' : 'personal access token'}
              onChange={(event) => update({ token: event.target.value })}
            />
            <p className="text-2xs text-doom-faint">
              Sent only to {form.host.trim() === '' ? 'this host' : form.host.trim()}. A remote on any other host keeps
              using this machine's own git credentials.
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="git-auth-save"
          disabled={problem !== undefined || saving}
          loading={saving}
          loadingLabel="saving"
          onClick={() => onSave(saveRequestOf(form))}
        >
          save
        </Button>
        {problem !== undefined ? (
          <span data-testid="git-auth-problem" className="text-2xs text-doom-yellow">
            {problem}
          </span>
        ) : saveError !== undefined ? (
          <span role="alert" data-testid="git-auth-error" className="flex items-center gap-1 text-2xs text-doom-red">
            <AlertIcon aria-hidden className="h-3 w-3" />
            {saveError}
          </span>
        ) : savedNotice ? (
          <span data-testid="git-auth-saved" className="text-2xs text-doom-green">
            saved
          </span>
        ) : null}
      </div>

      <p className="flex items-start gap-1.5 text-2xs text-doom-faint">
        <ShieldIcon aria-hidden className="mt-px h-3 w-3 shrink-0" />
        <span>
          Used only when you pull, push or rebase from this workspace's sessions in the cockpit, worktrees included. The
          agent's own git commands never see these credentials. Stored outside the repository in
          ~/.pi/.doom/git/credentials.json, readable only by you, and never in the system keychain.
        </span>
      </p>
    </div>
  );
}
