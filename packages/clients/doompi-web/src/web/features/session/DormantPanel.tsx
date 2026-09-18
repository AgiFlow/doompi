import { Button, RefreshIcon } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import { reviveSession } from '../../lib/hubApi';
import { abbreviateCwd } from '../../lib/sessionSummary';
import type { SessionMeta } from '../../stores/sessionsStore';

/** The prompt-area gate for a recorded session with no runtime behind it. */
export function DormantPanel({ meta }: { meta: SessionMeta }) {
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState('');
  const summary = meta.summary;

  const wake = async (): Promise<void> => {
    setWaking(true);
    setError('');
    const result = await reviveSession(summary.id);
    // The hub's live upsert unmounts this panel. Only a failure remains here.
    if ('error' in result) {
      setError(result.error);
      setWaking(false);
    }
  };

  return (
    <div
      data-testid="dormant-session"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-doom-border bg-doom-deep px-3 py-3"
    >
      <div className="min-w-0">
        <p className="font-bold text-doom-text">session stopped</p>
        <p className="text-xs leading-relaxed text-doom-dim">
          review the conversation above, then wake to continue. history is on disk in {abbreviateCwd(summary.cwd)}.
        </p>
        {error ? (
          <p role="alert" data-testid="dormant-error" className="mt-1 text-xs break-words text-doom-red">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        variant="primary"
        size="md"
        data-testid="dormant-wake"
        disabled={waking}
        onClick={() => {
          void wake();
        }}
      >
        <RefreshIcon className="h-3 w-3" />
        {waking ? 'waking' : 'wake session'}
      </Button>
    </div>
  );
}
