import type { WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import type { AuthorHubMessage } from '../types/webAuthor.ts';
import { authorChannelType } from '../types/webAuthor.ts';
import { AuthorRuntime } from './AuthorRuntime.ts';
import type { AuthorTrustedProfile } from './authorViewportTypes.ts';

interface ActiveViewport {
  sessionId: string;
  generation: number;
  profiles: readonly AuthorTrustedProfile[];
  release: () => void;
  ownerToken?: string;
  catalogToken?: string;
}

class AuthorBrowserBridge {
  readonly #host: WebPluginRuntime;
  readonly #runtime: AuthorRuntime;
  readonly #pending = new Map<string, AbortController>();
  #active: ActiveViewport | undefined;
  #generation = 0;
  #disposed = false;
  readonly #releaseConnected: () => void;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: WebPluginRuntime) {
    this.#host = host;
    this.#runtime = new AuthorRuntime(host);
    this.#releaseConnected = host.onHubConnected(() => {
      if (this.#active !== undefined) {
        this.#active.ownerToken = undefined;
        this.#active.catalogToken = undefined;
      }
      this.#register();
    });
  }

  async focus(sessionId: string, profiles: readonly AuthorTrustedProfile[]): Promise<() => void> {
    if (this.#disposed) throw new Error('Author browser bridge is disposed');
    const generation = ++this.#generation;
    const release = await this.#runtime.replaceProfiles(profiles);
    if (this.#disposed || generation !== this.#generation) {
      release();
      return () => undefined;
    }
    this.#clearActive();
    this.#active = { sessionId, generation, profiles, release };
    this.#register();
    return () => {
      if (this.#active?.generation !== generation) return;
      this.#clearActive();
      this.#generation += 1;
    };
  }

  drop(sessionId: string): void {
    if (this.#active?.sessionId !== sessionId) return;
    this.#clearActive();
    this.#generation += 1;
  }

  apply(sessionId: string, message: AuthorHubMessage): void {
    const active = this.#active;
    if (active === undefined || active.sessionId !== sessionId || message.kind === 'rejected') return;
    if (
      message.generation !== active.generation ||
      (message.ownerToken !== active.ownerToken && active.ownerToken !== undefined)
    )
      return;
    if (message.kind === 'accepted') {
      active.ownerToken = message.ownerToken;
      clearTimeout(this.#leaseTimer);
      this.#leaseTimer = setTimeout(() => this.#register(), Math.max(1000, Math.floor(message.leaseMs / 2)));
      if (message.catalogToken === undefined) this.#sendCatalog(active);
      else active.catalogToken = message.catalogToken;
      return;
    }
    if (message.catalogToken !== active.catalogToken) return;
    if (message.kind === 'cancel') {
      this.#pending.get(message.requestId)?.abort(new Error('Author tool request cancelled'));
      return;
    }
    if (message.kind !== 'request' || this.#pending.has(message.requestId)) return;
    const controller = new AbortController();
    this.#pending.set(message.requestId, controller);
    void this.#runtime
      .execute(message.name, message.arguments, controller.signal)
      .then((result) => {
        if (!this.#current(active, message.requestId, controller)) return;
        if (controller.signal.aborted) this.#sendCancelled(active, message.requestId);
        else
          this.#send(active.sessionId, {
            kind: 'result',
            generation: active.generation,
            ownerToken: active.ownerToken!,
            catalogToken: active.catalogToken!,
            requestId: message.requestId,
            result,
          });
      })
      .catch((error: unknown) => {
        if (!this.#current(active, message.requestId, controller)) return;
        if (controller.signal.aborted) this.#sendCancelled(active, message.requestId);
        else {
          const messageText = error instanceof Error ? error.message : String(error);
          const code = /^([A-Z][A-Z_]+):/u.exec(messageText)?.[1] ?? 'AUTHOR_TOOL_ERROR';
          this.#send(active.sessionId, {
            kind: 'result',
            generation: active.generation,
            ownerToken: active.ownerToken!,
            catalogToken: active.catalogToken!,
            requestId: message.requestId,
            result: { error: { code, message: messageText } },
          });
        }
      })
      .finally(() => {
        if (this.#pending.get(message.requestId) === controller) this.#pending.delete(message.requestId);
      });
  }

  activeView(sessionId: string): { activation: 'inactive' | 'active'; capabilityCount: number } {
    const active = this.#active;
    return active?.sessionId === sessionId && active.catalogToken !== undefined
      ? {
          activation: 'active',
          capabilityCount: active.profiles.reduce((count, profile) => count + profile.tools.length, 0),
        }
      : { activation: 'inactive', capabilityCount: 0 };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#leaseTimer);
    this.#releaseConnected();
    this.#clearActive();
    this.#runtime.dispose();
  }

  #register(): void {
    const active = this.#active;
    if (active !== undefined) this.#send(active.sessionId, { kind: 'register', generation: active.generation });
  }

  #sendCatalog(active: ActiveViewport): void {
    this.#send(active.sessionId, {
      kind: 'catalog',
      generation: active.generation,
      ownerToken: active.ownerToken!,
      tools: active.profiles.flatMap((profile) =>
        profile.tools.map((tool) => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ),
    });
  }

  #sendCancelled(active: ActiveViewport, requestId: string): void {
    this.#send(active.sessionId, {
      kind: 'cancelled',
      generation: active.generation,
      ownerToken: active.ownerToken!,
      catalogToken: active.catalogToken!,
      requestId,
    });
  }

  #send(sessionId: string, payload: Record<string, unknown>): void {
    this.#host.sendHubFrame({ type: authorChannelType, sessionId, payload });
  }

  #current(active: ActiveViewport, requestId: string, controller: AbortController): boolean {
    return this.#active === active && this.#pending.get(requestId) === controller;
  }

  #clearActive(): void {
    clearTimeout(this.#leaseTimer);
    this.#leaseTimer = undefined;
    const active = this.#active;
    if (active !== undefined) {
      this.#send(active.sessionId, { kind: 'release', generation: active.generation });
      active.release();
    }
    this.#active = undefined;
    for (const controller of this.#pending.values()) controller.abort(new Error('Author viewport changed'));
    this.#pending.clear();
  }
}

const authorBridgeRuntime = new Store<AuthorBrowserBridge | undefined>(undefined);

export function startAuthorBrowserBridge(runtime: WebPluginRuntime): () => void {
  authorBridgeRuntime.state?.dispose();
  const next = new AuthorBrowserBridge(runtime);
  authorBridgeRuntime.setState(() => next);
  return () => {
    if (authorBridgeRuntime.state !== next) return;
    next.dispose();
    authorBridgeRuntime.setState(() => undefined);
  };
}

export async function focusAuthorViewport(
  sessionId: string,
  profiles: readonly AuthorTrustedProfile[],
): Promise<() => void> {
  return (await authorBridgeRuntime.state?.focus(sessionId, profiles)) ?? (() => undefined);
}

export function applyAuthorHubMessage(sessionId: string, message: AuthorHubMessage): void {
  authorBridgeRuntime.state?.apply(sessionId, message);
}

export function dropAuthorViewportSession(sessionId: string): void {
  authorBridgeRuntime.state?.drop(sessionId);
}

export function authorBridgeView(sessionId: string): { activation: 'inactive' | 'active'; capabilityCount: number } {
  return authorBridgeRuntime.state?.activeView(sessionId) ?? { activation: 'inactive', capabilityCount: 0 };
}
