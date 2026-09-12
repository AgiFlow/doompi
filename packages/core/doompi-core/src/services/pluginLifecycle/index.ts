export interface PluginLifecycleContext {
  readonly signal: AbortSignal;
}

export interface PluginLifecycleHooks<TContext> {
  onStart?(this: void, context: TContext): void | Promise<void>;
  onStop?(this: void, context: TContext): void | Promise<void>;
  onDispose?(this: void, context: TContext): void | Promise<void>;
}

export interface PluginLifecycle<TContext> {
  readonly context: TContext;
  own(cleanup: () => void | Promise<void>): void;
  mount<TDefinition extends PluginLifecycleHooks<TContext>>(
    definition: TDefinition | (() => TDefinition | Promise<TDefinition>),
    register: (definition: TDefinition) => void | Promise<void>,
  ): Promise<void>;
  dispose(): Promise<void>;
}

/** Owns one mounted plugin, independently of the host supplying its context. */
export function createPluginLifecycle<TContext>(
  makeContext: (signal: AbortSignal) => TContext,
): PluginLifecycle<TContext> {
  const controller = new AbortController();
  const context = makeContext(controller.signal);
  const cleanups: (() => void | Promise<void>)[] = [];
  let hooks: PluginLifecycleHooks<TContext> | undefined;
  let startup: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let started = false;
  let draining = false;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = Promise.resolve().then(async () => {
      // Wait only for startup, never mount's rollback promise.
      await startup?.catch(() => undefined);
      draining = true;
      const errors: unknown[] = [];
      const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      };
      const onStop = hooks?.onStop;
      if (started && onStop) await attempt(() => onStop(context));
      for (const cleanup of cleanups.reverse()) await attempt(cleanup);
      cleanups.length = 0;
      const onDispose = hooks?.onDispose;
      if (onDispose) await attempt(() => onDispose(context));
      if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed.');
    });
    controller.abort();
    return disposal;
  };

  return {
    context,
    own(cleanup) {
      if (draining) throw new Error('Cannot own a registration after plugin cleanup begins.');
      cleanups.push(cleanup);
    },
    mount(definition, register) {
      if (startup || disposal) return Promise.reject(new Error('A plugin lifecycle can only mount once.'));
      startup = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const resolved = typeof definition === 'function' ? await definition() : definition;
        hooks = resolved;
        controller.signal.throwIfAborted();
        await register(resolved);
        controller.signal.throwIfAborted();
        started = true;
        if (resolved.onStart) {
          await resolved.onStart(context);
        }
        controller.signal.throwIfAborted();
      });
      return startup.catch(async (error: unknown) => {
        try {
          await dispose();
        } catch (cleanupError) {
          const errors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
          throw new AggregateError([error, ...errors], 'Plugin startup and cleanup failed.', { cause: error });
        }
        throw error;
      });
    },
    dispose,
  };
}
