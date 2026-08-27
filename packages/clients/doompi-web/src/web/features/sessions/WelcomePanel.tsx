import { Button, EmptyState, Kbd, PlusIcon } from '@agimon-ai/doompi-web-components';
import { openNewSession } from '../../stores/newSessionStore.ts';

/**
 * What the cockpit shows before there is anything to show.
 *
 * It stands where the conversation goes, and it stands alone: the composer and
 * the selection bar address a session's agent, so with no session there is
 * nothing for them to address and the page hides them rather than offering a
 * box that sends nowhere.
 *
 * One action, because there is only one thing to do here. It opens the same
 * dialog the rail's plus and ctrl+t open, so a session starts the same way
 * however you asked for it.
 */
export function WelcomePanel() {
  return (
    <EmptyState
      data-testid="welcome"
      title="no session yet"
      description="a session is an agent working in one folder. start one to get going."
    >
      <Button variant="primary" size="lg" data-testid="welcome-new-session" onClick={() => openNewSession()}>
        <PlusIcon className="h-3 w-3" />
        new session
      </Button>
      <span className="flex items-center gap-1.5 text-[10px] text-doom-faint">
        <Kbd>ctrl+t</Kbd> new session · <Kbd>ctrl+k</Kbd> commands
      </span>
    </EmptyState>
  );
}
