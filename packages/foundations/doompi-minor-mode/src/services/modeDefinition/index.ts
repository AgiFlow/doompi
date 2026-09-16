import type {
  MinorModeArguments,
  MinorModeDescriptor,
  MinorModeOwnerActionResult,
  MinorModeOwnerHandle,
  MinorModeState,
} from '../../schemas/mode';

export interface MinorModeExecution {
  readonly signal: AbortSignal;
}

export interface MinorModeDefinition<TRuntime, TExecution extends MinorModeExecution = MinorModeExecution> {
  readonly descriptor: MinorModeDescriptor;
  state(runtime: TRuntime): MinorModeState;
  handleAction(
    runtime: TRuntime,
    actionId: string,
    argumentsValue: MinorModeArguments,
    execution: TExecution,
  ): MinorModeOwnerActionResult | void | Promise<MinorModeOwnerActionResult | void>;
}

export interface MinorModeOwner<TExecution extends MinorModeExecution = MinorModeExecution> {
  readonly definition: {
    readonly descriptor: MinorModeDescriptor;
    readonly initialState: MinorModeState;
    handleAction(
      actionId: string,
      argumentsValue: MinorModeArguments,
      execution: TExecution,
    ): Promise<MinorModeOwnerActionResult | void>;
  };
  state(): MinorModeState;
  publish(): void;
  attach(handle: MinorModeOwnerHandle): void;
  detach(): void;
  subscribe(listener: () => void): () => void;
}

export interface DefinedMinorMode<TRuntime, TExecution extends MinorModeExecution = MinorModeExecution> {
  readonly descriptor: MinorModeDescriptor;
  createOwner(runtime: TRuntime): MinorModeOwner<TExecution>;
}

/** Shares one typed mode definition across Pi and session-server owners. */
export function defineMinorMode<TRuntime, TExecution extends MinorModeExecution = MinorModeExecution>(
  mode: MinorModeDefinition<TRuntime, TExecution>,
): DefinedMinorMode<TRuntime, TExecution> {
  return {
    descriptor: mode.descriptor,
    createOwner(runtime: TRuntime): MinorModeOwner<TExecution> {
      let handle: MinorModeOwnerHandle | undefined;
      const listeners = new Set<() => void>();
      const state = (): MinorModeState => mode.state(runtime);
      const publish = (): void => {
        handle?.publish(state());
        listeners.forEach((listener) => listener());
      };
      return {
        definition: {
          descriptor: mode.descriptor,
          initialState: state(),
          async handleAction(actionId: string, args: MinorModeArguments, execution: TExecution) {
            execution.signal.throwIfAborted();
            const result = await mode.handleAction(runtime, actionId, args, execution);
            publish();
            return result;
          },
        },
        state,
        publish,
        attach: (owner: MinorModeOwnerHandle) => {
          handle = owner;
        },
        detach: () => {
          handle = undefined;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
  };
}
