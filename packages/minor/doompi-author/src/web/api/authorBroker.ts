import type { ModelContext } from '@agimon-ai/doompi-web-contracts';

/** Client-side broker transport. Calls always cross Model Context's execution boundary. */
export class AuthorClientBroker {
  readonly #modelContext: ModelContext;

  constructor(modelContext: ModelContext) {
    this.#modelContext = modelContext;
  }

  execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    return this.#modelContext.executeTool(name, JSON.stringify(input), { signal });
  }
}
