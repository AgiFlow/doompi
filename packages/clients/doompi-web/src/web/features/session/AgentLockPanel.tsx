import { Button, UnlockIcon } from '@agimon-ai/doompi-web-components';

import { setAgentLock } from '../../stores/sessionStore';

/** The prompt-area gate while the local agent is locked so a remote MCP agent can work. */
export function AgentLockPanel({ sessionId }: { sessionId: string }) {
  return (
    <div
      data-testid="agent-locked"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-doom-border bg-doom-deep px-3 py-3"
    >
      <div className="min-w-0">
        <p className="font-bold text-doom-text">local agent locked</p>
        <p className="text-xs leading-relaxed text-doom-dim">
          it will not start turns, so remote MCP agents can work without it. unlock to chat here.
        </p>
      </div>
      <Button variant="primary" size="md" data-testid="agent-unlock" onClick={() => setAgentLock(false, sessionId)}>
        <UnlockIcon className="h-3 w-3" />
        unlock agent
      </Button>
    </div>
  );
}
