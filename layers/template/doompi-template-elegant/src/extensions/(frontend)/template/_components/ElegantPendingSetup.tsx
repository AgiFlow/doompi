import type { WebTemplateRailActions, WebTemplateRailPendingSetup } from '@agimon-ai/doompi-core/web';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  KebabIcon,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

/** A setup-only reservation: no runtime, so it offers removal and nothing else. */
export function ElegantPendingSetup({
  sessionId,
  setup,
  actions,
}: {
  sessionId: string;
  setup: WebTemplateRailPendingSetup;
  actions: WebTemplateRailActions;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await actions.removePendingSetup(sessionId, setup.id);
    setBusy(false);
    if (result !== undefined) setError(result.error);
  };
  return (
    <div
      data-testid={`pending-session-${setup.id}`}
      className="ml-9 flex flex-col gap-0.5 rounded-lg border border-dashed border-doom-border-soft px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-bold text-doom-hi">{setup.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title="session setup actions"
              disabled={busy}
              data-testid={`pending-session-menu-${setup.id}`}
            >
              <KebabIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              remove setup
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className={setup.failed ? 'text-2xs text-doom-red' : 'text-2xs text-doom-faint'}>{setup.status}</p>
      {setup.recovery ? (
        <p role={setup.failed ? 'alert' : undefined} className="text-2xs text-doom-faint">
          {setup.recovery}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-2xs text-doom-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
