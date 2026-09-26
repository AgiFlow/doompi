import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { Store } from '@tanstack/store';

import type { AuthorBrowserMessage, AuthorHubMessage } from '../../../../../types/webAuthor';
import { AuthorRuntime } from './authorRuntime';
import type { AuthorTrustedProfile } from './authorViewportTypes';

type Canvas = {
  sessionId: string;
  alias: string;
  generation: number;
  profiles: readonly AuthorTrustedProfile[];
  documentProfiles: readonly AuthorTrustedProfile[];
  runtime: AuthorRuntime;
  release: () => void;
  ownerToken?: string;
  catalogToken?: string;
  pending: Map<string, AbortController>;
  leaseTimer?: ReturnType<typeof setTimeout>;
  visible: boolean;
  focusId: number;
  replacementId: number;
};

const canvasKey = (sessionId: string, alias: string): string => `${sessionId}\n${alias}`;
const VISIBLE_ONLY = new Set(['author_describe_grid', 'author_resolve_grid_cell']);
const documentProfiles = (profiles: readonly AuthorTrustedProfile[]): readonly AuthorTrustedProfile[] =>
  profiles.map((profile) => ({ ...profile, tools: profile.tools.filter((tool) => !VISIBLE_ONLY.has(tool.name)) }));

class AuthorBrowserBridge {
  readonly #host: WebPluginRuntime;
  readonly #canvases = new Map<string, Canvas>();
  readonly #opening = new Map<string, { promise: Promise<void>; runtime: AuthorRuntime }>();
  #generation = 0;
  #disposed = false;
  readonly #releaseConnected: () => void;

  constructor(host: WebPluginRuntime) {
    this.#host = host;
    this.#releaseConnected = host.onHubConnected(() => {
      for (const canvas of this.#canvases.values()) {
        canvas.ownerToken = undefined;
        canvas.catalogToken = undefined;
        this.#register(canvas);
      }
    });
  }

  async open(sessionId: string, alias: string, profiles: readonly AuthorTrustedProfile[]): Promise<void> {
    if (this.#disposed) throw new Error('Author browser bridge is disposed');
    const key = canvasKey(sessionId, alias);
    if (this.#canvases.has(key)) return;
    const pending = this.#opening.get(key);
    if (pending !== undefined) return await pending.promise;
    const runtime = new AuthorRuntime(this.#host);
    const generation = ++this.#generation;
    const base = documentProfiles(profiles);
    let opening!: Promise<void>;
    opening = (async () => {
      const release = await runtime.replaceProfiles(base);
      if (this.#disposed || this.#canvases.has(key) || this.#opening.get(key)?.promise !== opening) {
        release();
        runtime.dispose();
        return;
      }
      const canvas: Canvas = {
        sessionId,
        alias,
        generation,
        profiles: base,
        documentProfiles: base,
        runtime,
        release,
        pending: new Map(),
        visible: false,
        focusId: 0,
        replacementId: 0,
      };
      this.#canvases.set(key, canvas);
      this.#register(canvas);
    })();
    this.#opening.set(key, { promise: opening, runtime });
    try {
      await opening;
    } finally {
      if (this.#opening.get(key)?.promise === opening) this.#opening.delete(key);
    }
  }

  async focus(sessionId: string, alias: string, profiles: readonly AuthorTrustedProfile[]): Promise<() => void> {
    await this.open(sessionId, alias, profiles);
    const canvas = this.#canvases.get(canvasKey(sessionId, alias));
    if (canvas === undefined) return () => undefined;
    canvas.visible = true;
    const focusId = ++canvas.focusId;
    await this.#replace(canvas, profiles);
    return () => {
      if (this.#canvases.get(canvasKey(sessionId, alias)) !== canvas || canvas.focusId !== focusId) return;
      canvas.visible = false;
      canvas.focusId += 1;
      void this.#replace(canvas, canvas.documentProfiles);
    };
  }

  drop(sessionId: string, alias?: string): void {
    for (const [key, entry] of this.#opening) {
      if (key.startsWith(`${sessionId}\n`) && (alias === undefined || key === canvasKey(sessionId, alias))) {
        this.#opening.delete(key);
        entry.runtime.dispose();
      }
    }
    for (const canvas of this.#canvases.values()) {
      if (canvas.sessionId !== sessionId || (alias !== undefined && canvas.alias !== alias)) continue;
      this.#canvases.delete(canvasKey(sessionId, canvas.alias));
      this.#release(canvas);
      canvas.runtime.dispose();
    }
  }

  apply(sessionId: string, message: AuthorHubMessage): void {
    if (message.alias === undefined) return;
    const canvas = this.#canvases.get(canvasKey(sessionId, message.alias));
    if (canvas === undefined || message.kind === 'rejected') return;
    if (
      message.generation !== canvas.generation ||
      (message.ownerToken !== canvas.ownerToken && canvas.ownerToken !== undefined)
    )
      return;
    if (message.kind === 'accepted') {
      canvas.ownerToken = message.ownerToken;
      clearTimeout(canvas.leaseTimer);
      canvas.leaseTimer = setTimeout(() => this.#register(canvas), Math.max(1000, Math.floor(message.leaseMs / 2)));
      if (message.catalogToken === undefined) this.#sendCatalog(canvas);
      else canvas.catalogToken = message.catalogToken;
      return;
    }
    if (message.catalogToken !== canvas.catalogToken) return;
    if (message.kind === 'cancel') {
      canvas.pending.get(message.requestId)?.abort(new Error('Author tool request cancelled'));
      return;
    }
    if (message.kind !== 'request' || canvas.pending.has(message.requestId)) return;
    const controller = new AbortController();
    canvas.pending.set(message.requestId, controller);
    void canvas.runtime
      .execute(message.name, message.arguments, controller.signal)
      .then((result) => {
        if (!this.#current(canvas, message.requestId, controller)) return;
        if (controller.signal.aborted) this.#sendCancelled(canvas, message.requestId);
        else
          this.#send(canvas, {
            kind: 'result',
            alias: canvas.alias,
            generation: canvas.generation,
            ownerToken: canvas.ownerToken!,
            catalogToken: canvas.catalogToken!,
            requestId: message.requestId,
            result,
          });
      })
      .catch((error: unknown) => {
        if (!this.#current(canvas, message.requestId, controller)) return;
        if (controller.signal.aborted) this.#sendCancelled(canvas, message.requestId);
        else {
          const messageText = error instanceof Error ? error.message : String(error);
          const code = /^([A-Z][A-Z_]+):/u.exec(messageText)?.[1] ?? 'AUTHOR_TOOL_ERROR';
          this.#send(canvas, {
            kind: 'result',
            alias: canvas.alias,
            generation: canvas.generation,
            ownerToken: canvas.ownerToken!,
            catalogToken: canvas.catalogToken!,
            requestId: message.requestId,
            result: { error: { code, message: messageText } },
          });
        }
      })
      .finally(() => {
        if (canvas.pending.get(message.requestId) === controller) canvas.pending.delete(message.requestId);
      });
  }

  activeView(sessionId: string): { activation: 'inactive' | 'active'; capabilityCount: number } {
    const active = [...this.#canvases.values()].filter(
      (canvas) => canvas.sessionId === sessionId && canvas.catalogToken,
    );
    return active.length > 0
      ? {
          activation: 'active',
          capabilityCount: active.reduce(
            (count, canvas) => count + canvas.profiles.reduce((total, profile) => total + profile.tools.length, 0),
            0,
          ),
        }
      : { activation: 'inactive', capabilityCount: 0 };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseConnected();
    for (const canvas of this.#canvases.values()) {
      this.#release(canvas);
      canvas.runtime.dispose();
    }
    this.#canvases.clear();
    for (const entry of this.#opening.values()) entry.runtime.dispose();
    this.#opening.clear();
  }

  async #replace(canvas: Canvas, profiles: readonly AuthorTrustedProfile[]): Promise<void> {
    const key = canvasKey(canvas.sessionId, canvas.alias);
    if (this.#disposed || this.#canvases.get(key) !== canvas) return;
    this.#release(canvas);
    const generation = canvas.generation;
    const replacementId = ++canvas.replacementId;
    let release: () => void;
    try {
      release = await canvas.runtime.replaceProfiles(profiles);
    } catch (error) {
      if (canvas.replacementId !== replacementId || this.#canvases.get(key) !== canvas) return;
      throw error;
    }
    if (
      this.#disposed ||
      this.#canvases.get(key) !== canvas ||
      canvas.generation !== generation ||
      canvas.replacementId !== replacementId
    ) {
      release();
      return;
    }
    canvas.release = release;
    canvas.profiles = profiles;
    this.#register(canvas);
  }

  #register(canvas: Canvas): void {
    if (this.#canvases.get(canvasKey(canvas.sessionId, canvas.alias)) === canvas)
      this.#send(canvas, { kind: 'register', alias: canvas.alias, generation: canvas.generation });
  }

  #sendCatalog(canvas: Canvas): void {
    this.#send(canvas, {
      kind: 'catalog',
      alias: canvas.alias,
      generation: canvas.generation,
      ownerToken: canvas.ownerToken!,
      tools: canvas.profiles.flatMap((profile) =>
        profile.tools.map((tool) => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ),
    });
  }

  #sendCancelled(canvas: Canvas, requestId: string): void {
    this.#send(canvas, {
      kind: 'cancelled',
      alias: canvas.alias,
      generation: canvas.generation,
      ownerToken: canvas.ownerToken!,
      catalogToken: canvas.catalogToken!,
      requestId,
    });
  }

  #send(canvas: Canvas, payload: AuthorBrowserMessage): void {
    const workspaceId = this.#host.mount?.scope === 'session' ? this.#host.mount.workspaceId : undefined;
    const mount = workspaceId ? { scope: 'workspace' as const, workspaceId } : { scope: 'global' as const };
    void this.#host
      .invokeServerMethod({
        mount,
        service: 'author.bridge',
        method: 'send',
        input: { sessionId: canvas.sessionId, message: payload },
      })
      .catch(() => undefined);
  }

  #current(canvas: Canvas, requestId: string, controller: AbortController): boolean {
    return (
      this.#canvases.get(canvasKey(canvas.sessionId, canvas.alias)) === canvas &&
      canvas.pending.get(requestId) === controller
    );
  }

  #release(canvas: Canvas): void {
    clearTimeout(canvas.leaseTimer);
    canvas.leaseTimer = undefined;
    this.#send(canvas, { kind: 'release', alias: canvas.alias, generation: canvas.generation });
    canvas.release();
    for (const controller of canvas.pending.values()) controller.abort(new Error('Author viewport changed'));
    canvas.pending.clear();
    canvas.ownerToken = undefined;
    canvas.catalogToken = undefined;
    canvas.generation = ++this.#generation;
  }
}

const authorBridgeRuntimes = new Store<ReadonlyMap<string, AuthorBrowserBridge>>(new Map());
const bridgeFor = (sessionId: string): AuthorBrowserBridge | undefined =>
  authorBridgeRuntimes.state.get(sessionId) ?? authorBridgeRuntimes.state.get('global');

export function startAuthorBrowserBridge(runtime: WebPluginRuntime): () => void {
  const key = runtime.mount?.scope === 'session' ? runtime.mount.sessionId : 'global';
  const previous = authorBridgeRuntimes.state.get(key);
  previous?.dispose();
  const next = new AuthorBrowserBridge(runtime);
  authorBridgeRuntimes.setState((state) => new Map(state).set(key, next));
  return () => {
    if (authorBridgeRuntimes.state.get(key) !== next) return;
    next.dispose();
    authorBridgeRuntimes.setState((state) => {
      const remaining = new Map(state);
      remaining.delete(key);
      return remaining;
    });
  };
}

export async function openAuthorCanvas(
  sessionId: string,
  alias: string,
  profiles: readonly AuthorTrustedProfile[],
): Promise<void> {
  await bridgeFor(sessionId)?.open(sessionId, alias, profiles);
}

export async function focusAuthorViewport(
  sessionId: string,
  profiles: readonly AuthorTrustedProfile[],
  alias = 'default',
): Promise<() => void> {
  return (await bridgeFor(sessionId)?.focus(sessionId, alias, profiles)) ?? (() => undefined);
}

export function applyAuthorHubMessage(sessionId: string, message: AuthorHubMessage): void {
  bridgeFor(sessionId)?.apply(sessionId, message);
}

export function dropAuthorViewportSession(sessionId: string, alias?: string): void {
  bridgeFor(sessionId)?.drop(sessionId, alias);
}

export function authorBridgeView(sessionId: string): { activation: 'inactive' | 'active'; capabilityCount: number } {
  return bridgeFor(sessionId)?.activeView(sessionId) ?? { activation: 'inactive', capabilityCount: 0 };
}
