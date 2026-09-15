import { Button, EmptyState, RefreshIcon } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import { reviveSession } from '../../lib/hubApi';
import { abbreviateCwd } from '../../lib/sessionSummary';
import type { SessionMeta } from '../../stores/sessionsStore';

/**
 * What a recorded session shows before the server reopens it.
 *
 * Restoring is deliberately not automatic: the cockpit focuses a session on
 * load, and waking whatever happens to sort first would spend a workspace sync
 * and a full composition on a session nobody asked for. This is the ask.
 */
export function DormantPanel({ meta }: { meta: SessionMeta }) {
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState('');
  const summary = meta.summary;

  const wake = async (): Promise<void> => {
    setWaking(true);
    setError('');
    const result = await reviveSession(summary.id);
    // On success the hub's upsert replaces this card with a live one and
    // unmounts the panel, so only the failure path has anything left to say.
    if ('error' in result) {
      setError(result.error);
      setWaking(false);
    }
  };

  return (
    <EmptyState
      data-testid="dormant-session"
      title={`${summary.name} is not running`}
      description={`its history is on disk in ${abbreviateCwd(summary.cwd)}. waking it starts the agent again and continues any turn that was cut off.`}
    >
      <Button
        variant="primary"
        size="lg"
        data-testid="dormant-wake"
        disabled={waking}
        onClick={() => {
          void wake();
        }}
      >
        <RefreshIcon className="h-3 w-3" />
        {waking ? 'waking' : 'wake session'}
      </Button>
      {error ? (
        <span data-testid="dormant-error" className="text-xs break-words text-doom-red">
          {error}
        </span>
      ) : null}
    </EmptyState>
  );
}
