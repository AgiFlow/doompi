import { lazy, Suspense } from 'react';
import { cn } from '../lib/cn.ts';
import type { CodeEditorProps } from '../types/editor.ts';
import { Skeleton } from './Skeleton.tsx';

/**
 * A code editor: line numbers, syntax colour, folding, undo, and a search
 * panel on the usual keys.
 *
 * The editor arrives as its own chunk. The cockpit is one bundle that every
 * session downloads, most of them without ever opening a file, and it is read
 * over a tunnel as often as over localhost; an editor nobody opened has no
 * business in that first load. What this module holds is the boundary, so the
 * cost is paid on the first render that asks for an editor and never again.
 */
const CodeEditorView = lazy(async () => ({ default: (await import('./CodeEditorView.tsx')).CodeEditorView }));

export function CodeEditor({ className, ...props }: CodeEditorProps) {
  return (
    <Suspense fallback={<Skeleton className={cn('min-h-0', className)} />}>
      <CodeEditorView className={className} {...props} />
    </Suspense>
  );
}
