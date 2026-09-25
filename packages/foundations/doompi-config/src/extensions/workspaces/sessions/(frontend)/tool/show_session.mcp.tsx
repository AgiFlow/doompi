import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFields, McpToolFrame } from '@agimon-ai/doompi-web-components';
import { useEffect, useRef, useState } from 'react';

import type { SessionView } from '../../../../../types/sessionView';

function sessionView(value: unknown): SessionView | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.sessionId !== 'string' ||
    !data.sessionId ||
    typeof data.repositoryName !== 'string' ||
    typeof data.majorMode !== 'string' ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 0 ||
    (data.profile !== null && typeof data.profile !== 'string')
  )
    return undefined;
  if (
    !['domains', 'layers', 'minorModes'].every(
      (key) => Array.isArray(data[key]) && data[key].every((item: unknown) => typeof item === 'string'),
    )
  )
    return undefined;
  return data as unknown as SessionView;
}

function ShowSessionMcpWidget(props: DoomMcpWidgetProps) {
  const [refreshed, setRefreshed] = useState<DoomMcpWidgetProps['result']>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const result = refreshed ?? props.result;
  const view = sessionView(result?.structuredContent);
  const original = sessionView(props.result?.structuredContent);
  const error =
    refreshError ??
    (result?.isError
      ? 'Session could not be loaded. Check the Doompi connection.'
      : result && !view
        ? 'The host returned an invalid session summary.'
        : view && original && view.sessionId !== original.sessionId
          ? 'The session changed. Reopen this widget from the conversation.'
          : undefined);
  const refresh = async (): Promise<void> => {
    if (!props.refresh || busy) return;
    setBusy(true);
    setRefreshError(undefined);
    try {
      const next = await props.refresh();
      if (alive.current) setRefreshed(next);
    } catch {
      if (alive.current) setRefreshError('Refresh failed. Check the Doompi connection, then try again.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <McpToolFrame
      {...props}
      result={result}
      title="Doompi session"
      error={error}
      phase={error ? 'error' : busy ? 'running' : props.phase}
    >
      <button
        type="button"
        disabled={!props.refresh || !props.result || busy || props.phase === 'cancelled'}
        onClick={() => {
          void refresh();
        }}
        className="rounded-md border border-doom-border bg-doom-panel px-3 py-2 text-base text-doom-text focus-visible:outline disabled:opacity-50"
      >
        Refresh
      </button>
      {view && !error ? (
        <McpToolFields
          fields={[
            ['Repository', view.repositoryName],
            ['Session', view.sessionId],
            ['Revision', view.revision],
            ['Profile', view.profile ?? 'Default'],
            ['Major mode', view.majorMode],
            ['Domains', view.domains.length ? view.domains : 'None'],
            ['Layers', view.layers.length ? view.layers : 'None'],
            ['Minor modes', view.minorModes.length ? view.minorModes : 'None'],
          ]}
        />
      ) : null}
    </McpToolFrame>
  );
}

export default defineMcpWidget(ShowSessionMcpWidget);
