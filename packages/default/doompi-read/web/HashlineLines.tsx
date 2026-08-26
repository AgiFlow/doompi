import type { PresentedLine } from './hashlineView.ts';

/**
 * The anchored body shared by hashline results: a file heading per group, a
 * right-aligned line-number gutter, and a `>>` marker on grep matches. The
 * gutter width is a style, not a class, because it follows the widest number.
 */
export function HashlineLines({ lines, gutter }: { lines: readonly PresentedLine[]; gutter: number }) {
  return (
    <div className="flex flex-col font-mono">
      {lines.map((line, index) => {
        if (line.type === 'file') {
          return (
            <span key={index} className="mt-1 truncate text-doom-faint first:mt-0">
              {line.path}
            </span>
          );
        }
        if (line.type === 'plain') {
          return (
            <span key={index} className="whitespace-pre-wrap break-words text-doom-dim">
              {line.text}
            </span>
          );
        }
        const { value } = line;
        return (
          <span key={index} className="flex gap-2">
            {value.marker !== undefined ? (
              <span className={`w-4 shrink-0 ${value.marker === 'match' ? 'text-doom-blue' : 'text-doom-faint'}`}>
                {value.marker === 'match' ? '>>' : ''}
              </span>
            ) : null}
            <span className="shrink-0 text-right text-doom-faint" style={{ width: `${gutter}ch` }}>
              {value.line}
            </span>
            <span
              className={`min-w-0 whitespace-pre-wrap break-words ${value.marker === 'match' ? 'text-doom-hi' : 'text-doom-text'}`}
            >
              {value.content}
            </span>
          </span>
        );
      })}
    </div>
  );
}
