import type {
  MinorModeActionResponse,
  MinorModeArguments,
  MinorModeCatalogService,
  MinorModeCatalogSnapshot,
  MinorModeInvokeOptions,
  MinorModeRecord,
  MinorModeRegistrationRef,
} from './mode.ts';

/** Read-only facade used by UI and voice surfaces over the injected service. */
export interface MinorModeCatalogClient {
  getSnapshot(): MinorModeCatalogSnapshot;
  list(): MinorModeRecord[];
  subscribe(listener: () => void): () => void;
  invoke(
    mode: MinorModeRegistrationRef,
    actionId: string,
    argumentsValue?: MinorModeArguments,
    options?: MinorModeInvokeOptions,
  ): Promise<MinorModeActionResponse>;
}

export function createMinorModeCatalogClient(catalog: MinorModeCatalogService): MinorModeCatalogClient {
  return {
    getSnapshot: () => catalog.getSnapshot(),
    list: () => catalog.list(),
    subscribe: (listener) => catalog.subscribe(listener),
    invoke: (mode, actionId, argumentsValue = {}, options = {}) =>
      catalog.invoke(
        {
          operationId: `minor-mode:${crypto.randomUUID()}`,
          mode: structuredClone(mode),
          actionId,
          arguments: structuredClone(argumentsValue),
        },
        'doom/minor-mode-client',
        options.signal,
      ),
  };
}
