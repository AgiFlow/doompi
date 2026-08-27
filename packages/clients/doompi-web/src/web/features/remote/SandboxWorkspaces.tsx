import { Button, Input } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import { updateRemoteSettings } from '../../stores/remoteAccessStore.ts';

/**
 * The directories the contained cockpit is allowed to see.
 *
 * This list is the boundary, not a convenience. A hub inside the container
 * cannot create a session in a path that is not mounted, so what is not here is
 * unreachable by anything the remote device asks for, including the agent's
 * shell. Editing it therefore reads as a security decision and is spelled out
 * as one.
 */

const ABSOLUTE = '/';

export interface SandboxWorkspacesProps {
  workspaces: readonly string[];
}

export function SandboxWorkspaces({ workspaces }: SandboxWorkspacesProps) {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const valid = trimmed.startsWith(ABSOLUTE) && !workspaces.includes(trimmed);

  const add = (): void => {
    if (!valid) return;
    setDraft('');
    void updateRemoteSettings({ sandbox: { enabled: true, workspaces: [...workspaces, trimmed] } });
  };

  const remove = (path: string): void => {
    void updateRemoteSettings({
      sandbox: { enabled: true, workspaces: workspaces.filter((workspace) => workspace !== path) },
    });
  };

  return (
    <div className="flex flex-col gap-2 pl-4" data-testid="sandbox-workspaces">
      {workspaces.length === 0 ? (
        <p className="text-[11px] text-doom-faint">
          Nothing is mounted yet, so the container would have no directory to work in. Add at least one.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {workspaces.map((workspace) => (
            <li key={workspace} className="flex items-center justify-between gap-2">
              <code className="truncate text-[11px] text-doom-hi">{workspace}</code>
              <Button
                variant="ghost"
                data-testid={`sandbox-workspace-remove-${workspace}`}
                onClick={() => {
                  remove(workspace);
                }}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          data-testid="sandbox-workspace-input"
          placeholder="/absolute/path/to/a/repository"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <Button variant="outline" data-testid="sandbox-workspace-add" disabled={!valid} onClick={add}>
          add
        </Button>
      </div>
      <p className="text-[11px] text-doom-faint">
        Absolute paths only, mounted at the same path inside. Sessions working anywhere else stay on the host and will
        not appear in the contained cockpit.
      </p>
    </div>
  );
}
