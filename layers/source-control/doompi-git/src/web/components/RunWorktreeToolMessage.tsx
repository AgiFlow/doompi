import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';

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
 * The action and its subject go in the heading because that is what a reader
 * scanning a transcript needs: "close_worktree a1b2c3d4" answers the question
 * the raw JSON arguments make them decode.
 */
export function RunWorktreeToolMessage({ args, output, running, isError }: ToolMessageRenderProps) {
  const action = typeof args.action === 'string' ? args.action : '';
  const subject = typeof args.branch === 'string' ? args.branch : typeof args.id === 'string' ? args.id : '';

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-bold text-doom-hi">
        {ACTION_LABEL[action] ?? 'Worktree'}
        {subject === '' ? '' : ` ${subject}`}
        {running ? ' …' : ''}
      </span>
      {output !== '' && (
        <pre className={`whitespace-pre-wrap text-xs ${isError ? 'text-doom-red' : 'text-doom-dim'}`}>{output}</pre>
      )}
    </div>
  );
}
