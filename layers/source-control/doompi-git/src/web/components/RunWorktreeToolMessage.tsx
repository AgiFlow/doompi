import { MessageItem, MessageItemBody, MessageItemHeader, toolTone } from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-core/web';

const ACTION_LABEL: Readonly<Record<string, string>> = {
  spawn_worktree: 'Create worktree',
  close_worktree: 'Close worktree',
  list: 'List worktrees',
  status: 'Worktree status',
  merge: 'Merge worktree',
  prune: 'Prune worktrees',
  send: 'Message worktree',
  messages: 'Read worktree messages',
};

/**
 * The timeline item for `run_worktree`.
 *
 * DESIGN PATTERNS:
 * - Built on MessageItem, like every other tool renderer in the cockpit. That
 *   is what gives it the shared collapse toggle and the RUNNING/OK/ERROR badge
 *   rather than a hand-rolled ellipsis that never resolves.
 * - The action and its subject go in the heading because that is what a reader
 *   scanning a transcript needs: "close_worktree a1b2c3d4" answers the question
 *   the raw JSON arguments make them decode.
 * - A create takes as long as the cockpit needs to start a session, and the
 *   tool streams each phase into `output`, so the body is where the wait is
 *   visible.
 */
export function RunWorktreeToolMessage({ args, output, running, isError }: ToolMessageRenderProps) {
  const action = typeof args.action === 'string' ? args.action : '';
  const subject = typeof args.branch === 'string' ? args.branch : typeof args.id === 'string' ? args.id : '';

  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={output !== ''}>
      <MessageItemHeader title={ACTION_LABEL[action] ?? 'Worktree'}>
        {subject === '' ? null : <span className="min-w-0 truncate text-doom-dim">{subject}</span>}
      </MessageItemHeader>
      {output === '' ? null : (
        <MessageItemBody>
          <pre className={`whitespace-pre-wrap text-xs ${isError ? 'text-doom-red' : 'text-doom-dim'}`}>{output}</pre>
        </MessageItemBody>
      )}
    </MessageItem>
  );
}
