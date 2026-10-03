import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_HOOK_TIMEOUT_SECONDS } from '../../constants/hookRunner';
import type {
  HookContext,
  HookHandlers,
  HookModule,
  HookModuleDescriptor,
  HookModuleResult,
} from '../../types/hookModule';
import type { HookModuleOutcome, HookModules, HookModulesOptions } from './type';

interface Instance {
  lifetime: AbortController;
  queue: Promise<unknown>;
  handlers?: HookHandlers;
  quarantined: boolean;
  settled: boolean;
  disposed: boolean;
  hostEffectFailure?: { error: unknown };
}
function assertHostEffects(instance: Instance): void {
  if (instance.hostEffectFailure) throw instance.hostEffectFailure.error;
}
const HANDLER_NAMES = ['tool_call', 'tool_result', 'session_start', 'agent_settled', 'dispose'] as const;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateHandlers(value: unknown): asserts value is HookHandlers {
  if (
    !object(value) ||
    Object.entries(value).some(
      ([key, handler]) =>
        !HANDLER_NAMES.includes(key as (typeof HANDLER_NAMES)[number]) || typeof handler !== 'function',
    )
  ) {
    throw new Error('setup must return hook handlers');
  }
}
function jsonValue(value: unknown, ancestors = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => jsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}
function validResult(event: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value)) return false;
  if (event === 'tool_call')
    return (
      Object.keys(value).every((key) => ['block', 'reason'].includes(key)) &&
      (value.block === undefined || typeof value.block === 'boolean') &&
      (value.reason === undefined || typeof value.reason === 'string')
    );
  if (event !== 'tool_result') return false;
  return (
    Object.keys(value).every((key) => ['content', 'details', 'isError'].includes(key)) &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    (value.details === undefined || jsonValue(value.details)) &&
    (value.content === undefined ||
      (Array.isArray(value.content) &&
        value.content.every(
          (part) =>
            object(part) &&
            ((part.type === 'text' && typeof part.text === 'string') ||
              (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')),
        )))
  );
}

/** One registry belongs to one session binding, never to the process. */
export function createHookModules(options: HookModulesOptions = {}): HookModules {
  const instances = new Map<string, Instance>();
  let descriptor: Promise<Map<string, string>> | undefined;
  let closed = false;
  let disposal: Promise<void> | undefined;
  function artifacts(): Promise<Map<string, string>> {
    descriptor ??= (async () => {
      if (!options.descriptor) return new Map<string, string>();
      const value: unknown = JSON.parse(await fs.readFile(options.descriptor.file, 'utf8'));
      if (!object(value) || value.version !== 1 || !Array.isArray(value.modules))
        throw new Error('invalid hook module descriptor');
      const result = new Map<string, string>();
      for (const entry of value.modules as HookModuleDescriptor['modules']) {
        if (
          !object(entry) ||
          typeof entry.source !== 'string' ||
          typeof entry.artifact !== 'string' ||
          !path.isAbsolute(entry.source) ||
          !path.isAbsolute(entry.artifact) ||
          !['.mjs', '.js', '.cjs'].includes(path.extname(entry.artifact)) ||
          result.has(entry.source)
        ) {
          throw new Error('invalid hook module artifact mapping');
        }
        result.set(entry.source, entry.artifact);
      }
      return result;
    })();
    return descriptor;
  }
  async function disposeInstance(instance: Instance): Promise<void> {
    if (!instance.handlers || instance.disposed) return;
    instance.disposed = true;
    await instance.handlers.dispose?.();
  }
  function contextFor(context: HookContext, instance: Instance, signal: AbortSignal): HookContext {
    function assertActive(message: boolean): void {
      if (closed || signal.aborted || instance.lifetime.signal.aborted) throw new Error('hook context revoked');
      if (message && instance.settled) throw new Error('agent_settled cannot send messages');
    }
    return {
      ...context,
      signal,
      async sendMessage(text, delivery) {
        assertActive(true);
        await context.sendMessage(text, delivery);
      },
      async appendCustomEntry(type, data) {
        assertActive(false);
        await context.appendCustomEntry(type, data);
      },
    };
  }
  return {
    async invoke(row, event, context, operationSignal): Promise<HookModuleOutcome> {
      const source = 'module' in row.hook ? row.hook.module : undefined;
      const failure = (error: unknown, timeout = false): HookModuleOutcome => ({
        failure: {
          command: source ?? '',
          reason: timeout ? 'timeout' : 'module_failed',
          message: `${row.registryId ?? ''}: group ${row.groupId ?? ''}, row ${row.rowId ?? ''}, event ${row.event ?? event.type}, module ${source ?? ''}: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      if (!source) return failure(new Error('not a module row'));
      if (closed || context.signal.aborted) return failure(new Error('hook session disposed'));
      const key = `${context.sessionId}\0${source}`;
      let instance = instances.get(key);
      if (!instance) {
        instance = {
          lifetime: new AbortController(),
          queue: Promise.resolve(),
          quarantined: false,
          settled: false,
          disposed: false,
        };
        instances.set(key, instance);
      }
      const current = instance;
      const hostContext: HookContext = {
        ...context,
        async sendMessage(text, delivery) {
          try {
            await context.sendMessage(text, delivery);
          } catch (error) {
            current.hostEffectFailure = { error };
            throw error;
          }
        },
        async appendCustomEntry(type, data) {
          try {
            await context.appendCustomEntry(type, data);
          } catch (error) {
            current.hostEffectFailure = { error };
            throw error;
          }
        },
      };
      const run = async (): Promise<HookModuleOutcome> => {
        if (closed || current.quarantined || current.lifetime.signal.aborted)
          return failure(new Error('module quarantined or disposed'));
        current.hostEffectFailure = undefined;
        current.settled = event.type === 'agent_settled';
        const controller = new AbortController();
        const signal = AbortSignal.any([
          context.signal,
          current.lifetime.signal,
          controller.signal,
          ...(operationSignal ? [operationSignal] : []),
        ]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let setup = !current.handlers;
        let timedOut = false;
        const operation = (async () => {
          if (!current.handlers) {
            const artifact = (await artifacts()).get(source);
            if (!artifact) throw new Error('sync required: module missing from descriptor');
            const imported: { default?: unknown } = await import(pathToFileURL(artifact).href);
            if (signal.aborted) throw new Error('hook context aborted');
            if (!object(imported.default) || typeof imported.default.setup !== 'function')
              throw new Error('module default export must declare setup');
            const handlers = await (imported.default as unknown as HookModule).setup(
              contextFor(hostContext, current, AbortSignal.any([context.signal, current.lifetime.signal])),
            );
            validateHandlers(handlers);
            current.handlers = handlers;
            if (closed || current.quarantined || signal.aborted) {
              await disposeInstance(current);
              return undefined;
            }
          }
          setup = false;
          const ctx = contextFor(hostContext, current, signal);
          switch (event.type) {
            case 'tool_call':
              return current.handlers.tool_call?.(event, ctx);
            case 'tool_result':
              return current.handlers.tool_result?.(event, ctx);
            case 'session_start':
              return current.handlers.session_start?.(event, ctx);
            case 'agent_settled':
              return current.handlers.agent_settled?.(event, ctx);
          }
        })();
        try {
          const aborted = new Promise<never>((_, reject) => {
            const abort = () => reject(new Error(timedOut ? 'hook module timed out' : 'hook context aborted'));
            signal.addEventListener('abort', abort, { once: true });
            operation.finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
            if (signal.aborted) abort();
            timer = setTimeout(
              () => {
                timedOut = true;
                controller.abort();
              },
              (row.hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000,
            );
          });
          const result = await Promise.race([operation, aborted]);
          assertHostEffects(current);
          if (!validResult(event.type, result))
            return { failure: { ...failure(new Error('invalid hook result')).failure!, reason: 'invalid_result' } };
          return result === undefined ? {} : { result: result as HookModuleResult };
        } catch (error) {
          assertHostEffects(current);
          if (setup || timedOut || signal.aborted) {
            current.quarantined = true;
            current.lifetime.abort();
          }
          return failure(error, timedOut);
        } finally {
          clearTimeout(timer);
          controller.abort();
          current.settled = false;
        }
      };
      const invocation = current.queue.then(run);
      // Admission failures still reject the caller, but must not poison serialization.
      current.queue = invocation.catch(() => undefined);
      return invocation;
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        closed = true;
        for (const instance of instances.values()) instance.lifetime.abort();
        await Promise.all(
          [...instances.values()].map(async (instance) => {
            await instance.queue;
            await disposeInstance(instance);
          }),
        );
      })();
      return disposal;
    },
  };
}
