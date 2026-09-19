import type { ToolCompletionEvent, ToolResultView, TransientTab } from '@agimon-ai/doompi-core/web';

import { sessionToolRenderer, sessionWebPluginsInstalled, subscribeWebPluginRegistry } from './pluginRegistry';

type Frame = Record<string, unknown>;

interface PendingCall {
  event: Omit<ToolCompletionEvent, 'result'>;
  toolName: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultView(value: unknown): ToolResultView | undefined {
  const result = record(value);
  if (result === undefined) return undefined;
  return { content: Array.isArray(result.content) ? result.content : [], details: result.details };
}

/**
 * Converts successful live tool completions into plugin-owned temporary tabs.
 * Calls wait for the originating session's verified composition, so an early
 * completion is neither lost nor resolved against whichever session is active.
 */
export function createToolCompletionTabs(open: (sessionId: string, tab: TransientTab) => void): {
  apply(sessionId: string, frame: Frame, replay?: boolean): void;
  dispose(): void;
} {
  const calls = new Map<string, PendingCall>();
  const completions = new Map<string, PendingCall & { result: ToolResultView }>();
  const completed = new Set<string>();
  const completedOrder: string[] = [];
  const keyOf = (sessionId: string, toolCallId: string) => `${sessionId}\u0000${toolCallId}`;

  const rememberCompleted = (key: string): void => {
    completed.add(key);
    completedOrder.push(key);
    if (completedOrder.length <= 512) return;
    const oldest = completedOrder.shift();
    if (oldest !== undefined) completed.delete(oldest);
  };

  const flush = (): void => {
    for (const [key, completion] of completions) {
      if (!sessionWebPluginsInstalled(completion.event.sessionId)) continue;
      completions.delete(key);
      rememberCompleted(key);
      const tab = sessionToolRenderer(completion.event.sessionId, completion.toolName)?.completionTab?.({
        ...completion.event,
        result: completion.result,
      });
      if (tab !== undefined) open(completion.event.sessionId, tab);
    }
  };
  const unsubscribe = subscribeWebPluginRegistry(flush);

  return {
    apply(sessionId, frame, replay = false) {
      const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : '';
      if (toolCallId === '') return;
      const key = keyOf(sessionId, toolCallId);
      if (frame.type === 'tool_execution_start') {
        if (completed.has(key)) return;
        calls.set(key, {
          toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
          event: {
            sessionId,
            toolCallId,
            args: record(frame.args) ?? {},
          },
        });
        return;
      }
      if (frame.type !== 'tool_execution_end' || completed.has(key) || completions.has(key)) return;
      if (replay) {
        calls.delete(key);
        rememberCompleted(key);
        return;
      }
      const call = calls.get(key);
      if (call === undefined) return;
      calls.delete(key);
      if (frame.isError === true) {
        rememberCompleted(key);
        return;
      }
      const result = resultView(frame.result);
      if (result === undefined) {
        rememberCompleted(key);
        return;
      }
      completions.set(key, { ...call, result });
      flush();
    },
    dispose() {
      unsubscribe();
      calls.clear();
      completions.clear();
      completed.clear();
      completedOrder.length = 0;
    },
  };
}
