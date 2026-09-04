import type { ModelContext, ModelContextBinding, ModelContextToolDescriptor } from '@agimon-ai/doompi-web-contracts';
import type { WebMcpSimulator } from './webmcpSimulator.ts';

interface ModelContextDocument {
  readonly modelContext?: unknown;
}

let bindingPromise: Promise<ModelContextBinding> | undefined;
let simulator: WebMcpSimulator | undefined;
let generation = 0;

function hasMethod(value: object, name: keyof ModelContext): boolean {
  return typeof (value as Record<keyof ModelContext, unknown>)[name] === 'function';
}

function isCompleteModelContext(value: unknown): value is ModelContext {
  if (typeof value !== 'object' || value === null) return false;
  return (
    hasMethod(value, 'registerTool') &&
    hasMethod(value, 'getTools') &&
    hasMethod(value, 'executeTool') &&
    hasMethod(value, 'addEventListener') &&
    hasMethod(value, 'removeEventListener')
  );
}

function cloneDescriptor(descriptor: ModelContextToolDescriptor): ModelContextToolDescriptor {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: structuredClone(descriptor.inputSchema),
  };
}

function bindNative(modelContext: ModelContext): ModelContext {
  return {
    registerTool: modelContext.registerTool.bind(modelContext),
    getTools: async () => (await modelContext.getTools()).map(cloneDescriptor),
    executeTool: modelContext.executeTool.bind(modelContext),
    addEventListener: modelContext.addEventListener.bind(modelContext),
    removeEventListener: modelContext.removeEventListener.bind(modelContext),
  };
}

function browserDocument(): ModelContextDocument {
  if (typeof document === 'undefined') return {};
  return document as unknown as ModelContextDocument;
}

/** Acquires one model-context binding for the lifetime of this page. */
export function acquireModelContext(host: ModelContextDocument = browserDocument()): Promise<ModelContextBinding> {
  bindingPromise ??= (async () => {
    const acquiredGeneration = generation;
    const native = host.modelContext;
    if (isCompleteModelContext(native)) return { kind: 'native', modelContext: bindNative(native) };

    const { createWebMcpSimulator } = await import('./webmcpSimulator.ts');
    const created = createWebMcpSimulator();
    if (acquiredGeneration === generation) simulator = created;
    else created.dispose();
    return { kind: 'simulator', modelContext: created };
  })();
  return bindingPromise;
}

/** Releases the fallback surface during root teardown. Native browser state remains browser-owned. */
export function disposeModelContextAdapter(): void {
  generation += 1;
  simulator?.dispose();
  simulator = undefined;
  bindingPromise = undefined;
}
