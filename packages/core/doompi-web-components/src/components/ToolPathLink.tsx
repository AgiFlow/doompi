import { cn } from '../lib/cn.ts';

/**
 * The file path in a tool call's header, as a link when something can open it.
 *
 * A read, a write and an edit all put a path in the same place, and a reader
 * who wants to see that file should not have to go looking for it in a file
 * list. Whether the path can be opened is not this component's business: the
 * host resolves it against whatever plugin owns files, and hands the answer
 * down as `onOpen`. Without one the path stays exactly what it was, plain
 * text, because a link that opens nothing is worse than no link.
 */

export interface ToolPathLinkProps {
  path: string;
  /** Opens the file; omitted when nothing installed can show it. */
  onOpen?: () => void;
  className?: string;
  /** Defaults to `tool-path`, which is how a test finds the link inside a call header. */
  'data-testid'?: string;
}

export function ToolPathLink({
  path,
  onOpen,
  className,
  'data-testid': testId = 'tool-path',
  ...props
}: ToolPathLinkProps) {
  if (onOpen === undefined) {
    return (
      <span data-slot="tool-path" data-testid={testId} className={cn('truncate text-doom-text', className)} {...props}>
        {path}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="tool-path"
      data-testid={testId}
      title={`open ${path}`}
      onClick={onOpen}
      className={cn('cursor-pointer truncate text-left text-doom-text hover:text-doom-blue hover:underline', className)}
      {...props}
    >
      {path}
    </button>
  );
}
