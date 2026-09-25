import type { DoomMcpWidgetProps } from '@agimon-ai/doompi-core/mcpWidget';
import type { ReactNode } from 'react';

/** Presentational primitives only. Each package chooses its own fields and result presentation. */
export function McpToolFrame({
  title,
  phase,
  result,
  error,
  children,
}: Pick<DoomMcpWidgetProps, 'phase' | 'result' | 'error'> & { title: string; children?: ReactNode }) {
  const failed = phase === 'error' || result?.isError === true;
  const status = failed
    ? 'Tool failed'
    : phase === 'result'
      ? 'Result received'
      : phase === 'cancelled'
        ? 'Tool cancelled'
        : phase === 'running'
          ? 'Running tool...'
          : phase === 'preparing'
            ? 'Preparing tool...'
            : 'Connecting to host...';
  return (
    <section className="min-w-0 rounded-md border border-doom-border bg-doom-bg p-4 text-base text-doom-text">
      <h1 className="m-0 break-words text-lg font-semibold">{title}</h1>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={failed ? 'my-2 text-doom-red' : 'my-2 text-doom-dim'}
      >
        {error ?? status}
      </p>
      {children}
    </section>
  );
}

function fieldText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return fieldText(value.join(', '));
  return undefined;
}

export function McpToolFields({ fields }: { fields: readonly (readonly [string, unknown])[] }) {
  const values = fields.flatMap(([label, value]) => {
    const text = fieldText(value);
    return text === undefined || text === '' ? [] : [{ label, text }];
  });
  if (values.length === 0) return null;
  return (
    <dl aria-label="Tool details" className="my-3 flex min-w-0 flex-col gap-2">
      {values.map(({ label, text }) => (
        <div key={label} className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
          <dt className="text-sm text-doom-dim">{label}</dt>
          <dd className="m-0 min-w-0 whitespace-pre-wrap break-all text-sm">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function McpToolOutput({ result }: Pick<DoomMcpWidgetProps, 'result'>) {
  if (result === null) return null;
  const limit = 8000;
  let text = '';
  let truncated = false;
  let nonText = 0;
  for (const block of result.content ?? []) {
    if (block.type !== 'text') {
      nonText += 1;
      continue;
    }
    const part = `${text ? '\n' : ''}${block.text}`;
    const remaining = Math.max(0, limit - text.length);
    truncated ||= part.length > remaining;
    text += part.slice(0, remaining);
  }
  if (!text && result.structuredContent) {
    const value = JSON.stringify(result.structuredContent, null, 2);
    text = value.slice(0, limit);
    truncated = value.length > limit;
  }
  return (
    <details open className="min-w-0 rounded-md border border-doom-border-soft">
      <summary className="cursor-pointer bg-doom-panel p-3 text-sm focus-visible:outline">Tool output</summary>
      <pre
        tabIndex={0}
        aria-label="Tool output preview"
        className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-sm"
      >
        {text || (nonText ? 'Non-text result returned to the agent.' : 'No text output.')}
      </pre>
      {truncated || nonText ? (
        <p className="m-0 border-t border-doom-border-soft p-3 text-sm text-doom-dim">
          {truncated ? 'Preview truncated. Full output remains in the tool result. ' : ''}
          {nonText ? `${nonText} non-text content item(s) returned to the agent.` : ''}
        </p>
      ) : null}
    </details>
  );
}
