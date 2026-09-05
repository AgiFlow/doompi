import type {
  ModelContext,
  ModelContextAbortSignal,
  ModelContextToolDescriptor,
  WebPluginRuntime,
} from '@agimon-ai/doompi-web-contracts';
import type { AuthorTrustedProfile, AuthorTrustedTool } from './authorViewportTypes.ts';

export const AUTHOR_RUNTIME_BINDING_IDS = {
  text: 'author.viewport.text',
  media: 'author.viewport.media',
} as const;

interface ActiveCatalog {
  generation: number;
  controller: AbortController;
  profiles: ReadonlyMap<string, AuthorTrustedProfile>;
}

function assertProfile(profile: AuthorTrustedProfile): void {
  if (profile.id.trim() === '') throw new Error('Author profile id must not be empty');
  if (profile.tools.length > 15) throw new Error('Author profiles may expose at most 15 tools');
  const names = new Set<string>();
  for (const tool of profile.tools) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(tool.name)) throw new Error(`Invalid Author tool name: ${tool.name}`);
    if (names.has(tool.name)) throw new Error(`Duplicate Author tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

function descriptorMatches(actual: ModelContextToolDescriptor, expected: AuthorTrustedTool): boolean {
  return (
    actual.name === expected.name &&
    actual.description === expected.description &&
    JSON.stringify(actual.inputSchema) === JSON.stringify(expected.inputSchema)
  );
}

function staleError(): Error {
  return new Error('Author viewport catalog is stale');
}

function invocationSignal(
  catalogSignal: AbortSignal,
  requestSignal: ModelContextAbortSignal,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const abortCatalog = (): void => controller.abort(catalogSignal.reason);
  const abortRequest = (): void => controller.abort(requestSignal.reason);
  if (catalogSignal.aborted) abortCatalog();
  else if (requestSignal.aborted) abortRequest();
  else {
    catalogSignal.addEventListener('abort', abortCatalog, { once: true });
    requestSignal.addEventListener('abort', abortRequest, { once: true });
  }
  return {
    signal: controller.signal,
    release: () => {
      catalogSignal.removeEventListener('abort', abortCatalog);
      requestSignal.removeEventListener('abort', abortRequest);
    },
  };
}

/** Owns page-lifetime WebMCP registrations. Profiles are replaced as one abortable catalog. */
export class AuthorRuntime {
  readonly #runtime: WebPluginRuntime;
  #context: ModelContext | undefined;
  #active: ActiveCatalog | undefined;
  #pending: ActiveCatalog | undefined;
  #generation = 0;
  #disposed = false;

  constructor(runtime: WebPluginRuntime) {
    this.#runtime = runtime;
  }

  async replaceProfiles(profiles: readonly AuthorTrustedProfile[]): Promise<() => void> {
    if (this.#disposed) throw new Error('Author runtime is disposed');
    for (const profile of profiles) assertProfile(profile);
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const tools = profiles.flatMap((profile) => profile.tools);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new Error('Author tool names must be unique across trusted profiles');
    }

    const context = this.#context ?? (await this.#runtime.acquireModelContext?.())?.modelContext;
    if (context === undefined) throw new Error('Model Context is unavailable');
    this.#context = context;
    const generation = ++this.#generation;
    const controller = new AbortController();
    const candidate: ActiveCatalog = { generation, controller, profiles: profileMap };
    const inactive = staleError();
    this.#pending?.controller.abort(inactive);
    this.#active?.controller.abort(inactive);
    this.#pending = candidate;
    this.#active = undefined;
    const assertCurrent = (): void => {
      if (controller.signal.aborted || this.#disposed || this.#active?.generation !== generation) throw staleError();
    };

    try {
      await Promise.all(
        tools.map(async (tool) =>
          context.registerTool(
            {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              execute: async (input, options) => {
                assertCurrent();
                const parsed: unknown = JSON.parse(input);
                assertCurrent();
                const invocation = invocationSignal(controller.signal, options.signal);
                try {
                  const result = await tool.execute(parsed, invocation.signal);
                  assertCurrent();
                  return result;
                } finally {
                  invocation.release();
                }
              },
            },
            { signal: controller.signal },
          ),
        ),
      );
      const registered = await context.getTools();
      if (!tools.every((tool) => registered.some((descriptor) => descriptorMatches(descriptor, tool)))) {
        throw new Error('Model Context did not confirm the Author catalog');
      }
      if (this.#disposed || generation !== this.#generation || this.#pending !== candidate) throw staleError();
      this.#pending = undefined;
      this.#active = candidate;
    } catch (error) {
      controller.abort(error);
      if (this.#pending === candidate) this.#pending = undefined;
      throw error;
    }

    return () => {
      if (this.#active?.generation !== generation) return;
      controller.abort(staleError());
      this.#active = undefined;
      this.#generation += 1;
    };
  }

  async execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const context = this.#context;
    if (context === undefined || this.#active === undefined) throw new Error('Author catalog is not registered');
    return context.executeTool(name, JSON.stringify(input), { signal });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#pending?.controller.abort(new Error('Author runtime disposed'));
    this.#active?.controller.abort(new Error('Author runtime disposed'));
    this.#pending = undefined;
    this.#active = undefined;
  }
}
