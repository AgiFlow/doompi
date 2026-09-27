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

/** A pending reservation has no runtime and must not inherit live-session actions. */
export function AdvancedPendingSetup({
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
      className="ml-4 rounded-md border border-doom-border-soft bg-doom-panel p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-bold text-doom-hi">{setup.name}</span>
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
      <p className={setup.failed ? 'text-xs text-doom-red' : 'text-xs text-doom-faint'}>{setup.status}</p>
      {setup.recovery ? (
        <p role={setup.failed ? 'alert' : undefined} className="text-xs text-doom-faint">
          {setup.recovery}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-doom-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
