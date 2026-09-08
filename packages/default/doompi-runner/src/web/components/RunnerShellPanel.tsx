import { Button, StatusBadge, type TerminalHandle, TerminalView } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import type { RunnerRunView } from '../../types/webRunners.ts';
import { decodeChunk, sendRunnerInput, watchRunnerScreen } from '../api/screenApi.ts';
import { runners } from '../stores/runnersStore.ts';

const TAB_ID_PREFIX = 'runner-shell-';
/** Keystrokes are gathered for this long and sent as one request. */
const FLUSH_MS = 30;

/** The temporary tab holding one interactive runner's pane. */
export function runnerShellTab(run: RunnerRunView): TransientTab {
  const runId = run.id;
  return {
    id: `${TAB_ID_PREFIX}${runId}`,
    label: `shell · ${run.name}`,
    panel: (props: WebPluginSlotProps) => <RunnerShellPanel {...props} runId={runId} />,
  };
}

/**
 * An interactive runner's pane, attached.
 *
 * A real terminal emulator, fed the pane's own bytes. The runner's sink keeps
 * an unscrubbed copy of its output beside the log for exactly this: the log is
 * stripped of cursor movement so it stays worth grepping, which is precisely
 * what a terminal needs. Because these are the original bytes, colour, cursor
 * placement and full-screen programs all render the way they would in a shell.
 *
 * xterm is loaded when the tab opens rather than with the plugin. Most sessions
 * never attach to anything, and an emulator is not a small thing to carry.
 */
export function RunnerShellPanel({ sessionId, runId }: WebPluginSlotProps & { runId: string }) {
  const { runs } = useStore(runners.store, (state) => runners.select(state, sessionId));
  const run = runs.find((candidate) => candidate.id === runId);
  const [ended, setEnded] = useState(false);
  const [lost, setLost] = useState(false);
  const [ready, setReady] = useState(false);
  const terminal = useRef<TerminalHandle | null>(null);
  const pending = useRef<string[]>([]);
  const flush = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (sessionId === null || !ready) return;
    const watch = watchRunnerScreen(sessionId, runId, 0, {
      onEvent: (event) => {
        if (event.chunk !== '') terminal.current?.write(decodeChunk(event.chunk));
        if (event.ended === true) setEnded(true);
      },
      onLost: () => setLost(true),
    });
    return () => watch.close();
  }, [sessionId, runId, ready]);

  useEffect(
    () => () => {
      if (flush.current !== undefined) clearTimeout(flush.current);
    },
    [],
  );

  // Batched: a burst of typing is one request rather than one per character,
  // and the pane sees the keys in the order they were pressed either way.
  const send = (text: string): void => {
    if (sessionId === null) return;
    pending.current.push(text);
    if (flush.current !== undefined) return;
    flush.current = setTimeout(() => {
      const batch = pending.current.join('');
      pending.current = [];
      flush.current = undefined;
      if (batch !== '') void sendRunnerInput(sessionId, runId, batch);
    }, FLUSH_MS);
  };

  const live = run?.state === 'running' && !ended;

  return (
    <div data-testid="runner-shell-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-3 sm:h-11 sm:px-[26px]">
        <span data-testid="runner-shell-name" className="shrink-0 truncate text-sm font-bold text-doom-hi">
          {run?.name ?? runId}
        </span>
        <StatusBadge tone={live ? 'running' : 'neutral'} data-testid="runner-shell-state">
          {live ? 'attached' : 'detached'}
        </StatusBadge>
        <span className="min-w-0 flex-1" />
        {lost ? (
          <span data-testid="runner-shell-lost" className="shrink-0 text-2xs text-doom-red">
            the connection to this pane dropped
          </span>
        ) : null}
        {live ? (
          <Button
            variant="outline"
            size="xs"
            data-testid="runner-shell-interrupt"
            title="send ctrl-c"
            onClick={() => send('\u0003')}
            className="px-2 text-2xs font-bold"
          >
            ctrl-c
          </Button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-doom-panel-deep px-3 py-2 sm:px-[26px]">
        <TerminalView
          ref={terminal}
          data-testid="runner-shell-terminal"
          onData={(text) => send(text)}
          onReady={() => setReady(true)}
        />
        {ready ? null : (
          <p data-testid="runner-shell-reading" className="text-xs text-doom-faint">
            attaching…
          </p>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center border-t border-doom-border-soft px-3 sm:px-[26px]">
        <span className="min-w-0 flex-1 truncate text-2xs text-doom-faint">
          {live ? 'typing goes straight to the runner' : 'this runner is no longer accepting input'}
        </span>
      </div>
    </div>
  );
}
