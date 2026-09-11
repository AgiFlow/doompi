import type {
  ModelContext,
  ModelContextAbortSignal,
  ModelContextExecutionOptions,
  ModelContextRegistrationOptions,
  ModelContextTool,
  ModelContextToolChangeListener,
  ModelContextToolDescriptor,
} from '@agimon-ai/doompi-web-contracts';

interface RegisteredTool {
  readonly descriptor: ModelContextToolDescriptor;
  readonly execute: ModelContextTool['execute'];
  readonly signal: ModelContextAbortSignal;
  readonly onAbort: () => void;
}

export interface WebMcpSimulator extends ModelContext {
  dispose(): void;
}

function abortReason(signal: ModelContextAbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function cloneDescriptor(descriptor: ModelContextToolDescriptor): ModelContextToolDescriptor {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.inputSchema),
  };
}

function rejectOnAbort(signal: ModelContextAbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Creates the in-page WebMCP surface used when the browser has no complete native one. */
export function createWebMcpSimulator(): WebMcpSimulator {
  const listeners = new Set<ModelContextToolChangeListener>();
  const tools = new Map<string, RegisteredTool>();
  const lifetime = new AbortController();
  let disposed = false;

  const emitToolChange = () => {
    for (const listener of listeners) listener({ type: 'toolchange' });
  };
  const remove = (name: string, expected?: RegisteredTool) => {
    const current = tools.get(name);
    if (current === undefined || (expected !== undefined && current !== expected)) return;
    current.signal.removeEventListener('abort', current.onAbort);
    tools.delete(name);
    emitToolChange();
  };

  return {
    registerTool(tool: ModelContextTool, options: ModelContextRegistrationOptions): void {
      if (disposed) throw new Error('The model context simulator has been disposed.');
      if (options.signal.aborted) throw abortReason(options.signal);
      if (tools.has(tool.name)) throw new Error(`A model context tool named '${tool.name}' is already registered.`);

      let registered: RegisteredTool;
      const onAbort = () => remove(tool.name, registered);
      registered = {
        descriptor: cloneDescriptor(tool),
        execute: async (input, executionOptions) => await tool.execute(input, executionOptions),
        signal: options.signal,
        onAbort,
      };
      tools.set(tool.name, registered);
      options.signal.addEventListener('abort', onAbort, { once: true });
      emitToolChange();
    },

    async getTools(): Promise<readonly ModelContextToolDescriptor[]> {
      return [...tools.values()].map(({ descriptor }) => cloneDescriptor(descriptor));
    },

    async executeTool(name: string, input: string, options: ModelContextExecutionOptions): Promise<unknown> {
      if (disposed) throw new Error('The model context simulator has been disposed.');
      if (options.signal.aborted) throw abortReason(options.signal);
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`No model context tool named '${name}' is registered.`);
      JSON.parse(input);
      const execution = new AbortController();
      const abortExecution = () => execution.abort(abortReason(options.signal));
      const abortForDisposal = () => execution.abort(abortReason(lifetime.signal));
      options.signal.addEventListener('abort', abortExecution, { once: true });
      lifetime.signal.addEventListener('abort', abortForDisposal, { once: true });
      const aborted = rejectOnAbort(execution.signal);
      try {
        return await Promise.race([
          Promise.resolve().then(async () => await tool.execute(input, { signal: execution.signal })),
          aborted.promise,
        ]);
      } finally {
        aborted.dispose();
        options.signal.removeEventListener('abort', abortExecution);
        lifetime.signal.removeEventListener('abort', abortForDisposal);
      }
    },

    addEventListener(_type: 'toolchange', listener: ModelContextToolChangeListener): void {
      listeners.add(listener);
    },

    removeEventListener(_type: 'toolchange', listener: ModelContextToolChangeListener): void {
      listeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifetime.abort(new DOMException('The model context simulator was disposed.', 'AbortError'));
      const registered = [...tools.values()];
      tools.clear();
      for (const tool of registered) tool.signal.removeEventListener('abort', tool.onAbort);
      if (registered.length > 0) emitToolChange();
      listeners.clear();
    },
  };
}
