import { cn } from '../lib/cn.ts';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip.tsx';

/** The marker a collapsed run of segments is shown as. */
export const BREADCRUMB_ELLIPSIS = '…';

/**
 * A path as breadcrumb segments, with the middle collapsed when it is deeper
 * than `keep` allows.
 *
 * The first segment and the last few are what place a leaf; the ones between
 * are what a reader skims past, so those are the ones that go. The leaf is
 * always the final segment and is never collapsed.
 */
export function breadcrumbSegments(path: string, keep = 4): string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return [path];
  if (segments.length <= keep) return segments;
  // One leading segment for orientation, then the tail that names the leaf.
  return [segments[0] ?? '', BREADCRUMB_ELLIPSIS, ...segments.slice(segments.length - (keep - 2))];
}

export interface BreadcrumbProps {
  /** The path to show, separated by forward slashes. */
  path: string;
  /** How many segments survive before the middle collapses. */
  keep?: number;
  /** Marks the trail so a test can find it. */
  'data-testid'?: string;
  className?: string;
}

/**
 * A slash-separated path, shortened to fit and readable in full on hover.
 *
 * Two things shorten it, because they solve different problems. Collapsing the
 * middle keeps a deep path legible at any width, and truncation handles what is
 * left when the container is narrower than even that. Either one hides
 * something, so the whole path is always one hover away, wrapped rather than
 * clipped: a tooltip that truncates too would defeat the point of having one.
 *
 * The leaf carries the emphasis. A reader scanning a header is looking for the
 * file, and the directories are context for it.
 */
export function Breadcrumb({ path, keep, className, 'data-testid': testId }: BreadcrumbProps) {
  const segments = breadcrumbSegments(path, keep);
  const lastIndex = segments.length - 1;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="breadcrumb"
            data-testid={testId}
            title={undefined}
            className={cn('flex min-w-0 items-baseline gap-1 truncate font-mono text-[12px]', className)}
          >
            {segments.map((segment, index) => (
              // Segments repeat in a path (src/app/src), so the index is what
              // keeps two of the same name apart.
              <span key={`${segment}-${String(index)}`} className="flex min-w-0 items-baseline gap-1">
                {index > 0 ? <span className="shrink-0 text-doom-faint">/</span> : null}
                <span
                  className={
                    index === lastIndex ? 'truncate font-bold text-doom-hi' : 'shrink-0 truncate text-doom-faint'
                  }
                >
                  {segment}
                </span>
              </span>
            ))}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[32rem] break-all whitespace-normal">{path}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
