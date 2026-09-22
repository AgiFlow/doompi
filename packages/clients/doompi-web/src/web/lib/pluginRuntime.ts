import * as WebContracts from '@agimon-ai/doompi-core/web';
import type { WebPluginDefinition, WebPluginRuntime, WebPluginMount } from '@agimon-ai/doompi-core/web';
import * as WebComponents from '@agimon-ai/doompi-web-components';
import * as WebSecurityBrowser from '@agimon-ai/doompi-web-security/browser';
import * as CodeMirrorState from '@codemirror/state';
import * as CodeMirrorView from '@codemirror/view';
import * as TanstackReactStore from '@tanstack/react-store';
import * as TanstackStore from '@tanstack/store';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactJsxRuntime from 'react/jsx-runtime';

import { activateVerifiedBundle, activateVerifiedPluginComposition } from '../../pwa/workerClient';
import type { SessionWebComposition } from '../../types/hub';
import {
  activateWebPluginSession,
  installSessionWebPlugins,
  activateWebPluginWorkspace,
  bindSessionWebWorkspace,
  installGlobalWebPlugins,
  installWorkspaceWebPlugins,
  removeWorkspaceWebPlugins,
  removeSessionWebPlugins,
  startPluginDefinitions,
  webPluginDiagnostics,
} from './pluginRegistry';
import { pluginsAtScope } from './pluginScopes';
import { sealedHttpSession } from './sealedSession';
import { verifiedDevComposition } from './verifiedDevComposition';

export const WEB_PLUGIN_RUNTIME_GLOBAL = 'DoomPiWebPluginRuntime';
export const WEB_PLUGIN_COMPOSITION_GLOBAL = 'DoomPiWebPluginComposition';

/** Host-owned module singletons consumed by independently built plugin compositions. */
export interface WebPluginRuntimeModules {
  react: typeof React;
  reactJsxRuntime: typeof ReactJsxRuntime;
  reactJsxDevRuntime: typeof ReactJsxDevRuntime;
  reactDom: typeof ReactDom;
  reactDomClient: typeof ReactDomClient;
  tanstackStore: typeof TanstackStore;
  tanstackReactStore: typeof TanstackReactStore;
  webContracts: typeof WebContracts;
  webComponents: typeof WebComponents;
  webSecurityBrowser: typeof WebSecurityBrowser;
  codemirrorState: typeof CodeMirrorState;
  codemirrorView: typeof CodeMirrorView;
}

const modules: WebPluginRuntimeModules = Object.freeze({
  react: React,
  reactJsxRuntime: ReactJsxRuntime,
  reactJsxDevRuntime: ReactJsxDevRuntime,
  reactDom: ReactDom,
  reactDomClient: ReactDomClient,
  tanstackStore: TanstackStore,
  tanstackReactStore: TanstackReactStore,
  webContracts: WebContracts,
  webComponents: WebComponents,
  webSecurityBrowser: WebSecurityBrowser,
  codemirrorState: CodeMirrorState,
  codemirrorView: CodeMirrorView,
});

Object.defineProperty(globalThis, WEB_PLUGIN_RUNTIME_GLOBAL, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: modules,
});

interface LoadedComposition {
  key: string;
  stop: () => void;
  styles: HTMLLinkElement[];
  releaseAssets: () => void;
}
interface CompositionsResponse {
  global?: SessionWebComposition;
  shell?: { publicKey: string; revision: number };
  workspaces: { id: string; webComposition?: SessionWebComposition }[];
}

export type WebPluginCompositionPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface WebPluginMountState {
  phase: WebPluginCompositionPhase;
  error?: string;
}

export interface WebPluginCompositionState extends WebPluginMountState {
  mounts: Record<string, WebPluginMountState>;
}

/** The host's composition bootstrap and per-mount readiness state. */
export const webPluginCompositionStore = new TanstackStore.Store<WebPluginCompositionState>({
  phase: 'idle',
  mounts: {},
});

const loadedMounts = new Map<string, LoadedComposition>();
const mountEpochs = new Map<string, number>();
const pendingMounts = new Map<string, Promise<void>>();
let runtime: WebPluginRuntime | undefined;
let runtimeEpoch = 0;
let focusEpoch = 0;
let scriptQueue: Promise<unknown> = Promise.resolve();
let localVerifier: { key: string; ready: Promise<void> } | undefined;
let pendingCompositionRefresh: Promise<void> | undefined;
let focusedSessionComposition:
  | { sessionId: string; composition?: SessionWebComposition; workspaceId?: string }
  | undefined;
/** The last session focus, reused while its session, composition, workspace and mount are unchanged. */
let lastSessionFocus:
  | {
      sessionId: string;
      key: string | undefined;
      workspaceId: string | undefined;
      runtimeEpoch: number;
      ownerEpoch: number;
      promise: Promise<void>;
    }
  | undefined;

async function bootstrapLocalVerifier(shell: CompositionsResponse['shell']): Promise<void> {
  if (typeof location === 'undefined' || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  // In-memory test hosts can supply plugin definitions without a signed shell.
  if (shell === undefined) return;
  const key = `${shell.publicKey}:${String(shell.revision)}`;
  if (localVerifier?.key !== key) {
    const ready = (async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const result = await activateVerifiedBundle({ publicKey: shell.publicKey, minimumRevision: shell.revision });
      if (!result.ok) throw new Error(`The local cockpit bundle was refused (${result.code}): ${result.message}`);
      if (navigator.serviceWorker.controller) return;
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (!navigator.serviceWorker.controller) return;
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          resolve();
        };
        const timeout = setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
          reject(new Error('The local verification worker did not take control.'));
        }, 10_000);
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        changed();
      });
    })();
    localVerifier = { key, ready };
    void ready.catch(() => {
      if (localVerifier?.ready === ready) localVerifier = undefined;
    });
  }
  await localVerifier.ready;
}

function mountKey(mount: WebPluginMount): string {
  return mount.scope === 'global'
    ? 'global'
    : mount.scope === 'workspace'
      ? `workspace:${mount.workspaceId}`
      : `session:${mount.sessionId}`;
}

function compositionKey(composition: SessionWebComposition): string {
  return `${composition.id}:${String(composition.revision)}`;
}

function clearCompositionGlobal(): void {
  delete (globalThis as unknown as Record<string, unknown>)[WEB_PLUGIN_COMPOSITION_GLOBAL];
}

async function executeCompositionScript(url: string): Promise<readonly WebPluginDefinition[]> {
  const execute = async (): Promise<readonly WebPluginDefinition[]> => {
    clearCompositionGlobal();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error(`The verified plugin script '${url}' failed to load.`)), {
        once: true,
      });
      document.head.append(script);
      script.addEventListener('load', () => script.remove(), { once: true });
      script.addEventListener('error', () => script.remove(), { once: true });
    });
    const plugins = (globalThis as unknown as Record<string, unknown>)[WEB_PLUGIN_COMPOSITION_GLOBAL];
    clearCompositionGlobal();
    if (!Array.isArray(plugins)) throw new Error('The verified plugin composition exported no plugin array.');
    return plugins as WebPluginDefinition[];
  };
  const queued = scriptQueue.then(execute, execute);
  scriptQueue = queued.catch(() => undefined);
  return await queued;
}

function disposeMount(key: string): void {
  mountEpochs.set(key, (mountEpochs.get(key) ?? 0) + 1);
  const loaded = loadedMounts.get(key);
  if (!loaded) return;
  loadedMounts.delete(key);
  try {
    loaded.stop();
  } finally {
    for (const style of loaded.styles) style.remove();
    loaded.releaseAssets();
  }
}

async function prepareStyles(
  composition: SessionWebComposition,
  assetUrl = (assetPath: string) => `${composition.verifiedAssetBaseUrl}${assetPath}`,
): Promise<HTMLLinkElement[]> {
  const links = composition.stylePaths.map((stylePath) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.media = 'not all';
    link.href = assetUrl(stylePath);
    link.dataset.doompiPluginComposition = composition.id;
    document.head.append(link);
    return link;
  });
  try {
    await Promise.all(
      links.map(
        async (link) =>
          await new Promise<void>((resolve, reject) => {
            link.addEventListener('load', () => resolve(), { once: true });
            link.addEventListener(
              'error',
              () => reject(new Error(`The verified plugin style '${link.href}' failed to load.`)),
              {
                once: true,
              },
            );
          }),
      ),
    );
    return links;
  } catch (error) {
    for (const link of links) link.remove();
    throw error;
  }
}

function reportDiagnostics(): void {
  for (const diagnostic of webPluginDiagnostics()) {
    console.warn(`web plugin '${diagnostic.pluginId}' ${diagnostic.kind}: ${diagnostic.message}`);
  }
}

/** Replace only the requested mount after its new assets have been verified. */
async function mountComposition(mount: WebPluginMount, composition: SessionWebComposition | undefined): Promise<void> {
  if (!runtime) return;
  const owner = mountKey(mount);
  const epoch = runtimeEpoch;
  const ownerEpoch = mountEpochs.get(owner) ?? 0;
  const stale = () => epoch !== runtimeEpoch || ownerEpoch !== (mountEpochs.get(owner) ?? 0);
  setMountState(owner, { phase: 'loading' });
  if (!composition) {
    const error = `No synchronized web composition exists for ${owner}.`;
    setMountState(owner, { phase: 'error', error });
    throw new Error(error);
  }
  const key = compositionKey(composition);
  const replace = async () => {
    if (stale()) return;
    if (loadedMounts.get(owner)?.key === key) {
      setMountState(owner, { phase: 'ready' });
      return;
    }
    let releaseAssets = () => {};
    let assetUrl = (assetPath: string) => `${composition.verifiedAssetBaseUrl}${assetPath}`;
    let styles: HTMLLinkElement[] = [];
    let definitions: readonly WebPluginDefinition[];
    try {
      const devKey: unknown = import.meta.env.VITE_DOOMPI_PLUGIN_PUBLIC_KEY;
      if (
        import.meta.env.DEV &&
        typeof devKey === 'string' &&
        devKey &&
        ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      ) {
        const assets = await verifiedDevComposition(composition, devKey);
        releaseAssets = assets.close;
        assetUrl = assets.url;
      } else {
        const verified = await activateVerifiedPluginComposition(composition);
        if (!verified.ok) throw new Error(`The plugin composition was refused (${verified.code}): ${verified.message}`);
      }
      if (stale()) {
        releaseAssets();
        return;
      }
      definitions = await executeCompositionScript(assetUrl(composition.entryPath));
      if (stale()) {
        releaseAssets();
        return;
      }
      styles = await prepareStyles(composition, assetUrl);
      if (stale() || !runtime) {
        for (const style of styles) style.remove();
        releaseAssets();
        return;
      }
    } catch (error) {
      releaseAssets();
      throw error;
    }
    const plugins = pluginsAtScope(definitions, mount.scope);
    const previous = loadedMounts.get(owner);
    previous?.stop();
    previous?.releaseAssets();
    for (const style of previous?.styles ?? []) style.remove();
    loadedMounts.delete(owner);
    try {
      if (mount.scope === 'global') installGlobalWebPlugins(definitions);
      else if (mount.scope === 'workspace') installWorkspaceWebPlugins(mount.workspaceId, definitions);
      else {
        bindSessionWebWorkspace(mount.sessionId, mount.workspaceId);
        installSessionWebPlugins(mount.sessionId, plugins);
      }
      const stop = startPluginDefinitions(plugins, { ...runtime, mount });
      for (const style of styles) style.media = 'all';
      loadedMounts.set(owner, { key, stop, styles, releaseAssets });
      setMountState(owner, { phase: 'ready' });
      reportDiagnostics();
    } catch (error) {
      for (const style of styles) style.remove();
      releaseAssets();
      throw error;
    }
  };
  const pending = (pendingMounts.get(owner) ?? Promise.resolve()).then(replace, replace);
  pendingMounts.set(owner, pending);
  try {
    await pending;
  } catch (error) {
    if (!stale()) setMountState(owner, { phase: 'error', error: compositionError(error) });
    throw error;
  } finally {
    if (pendingMounts.get(owner) === pending) pendingMounts.delete(owner);
  }
}

function compositionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setCompositionState(state: WebPluginMountState): void {
  webPluginCompositionStore.setState((current) => ({ ...current, ...state }));
}

function setMountState(key: string, state: WebPluginMountState): void {
  webPluginCompositionStore.setState((current) => ({
    ...current,
    mounts: { ...current.mounts, [key]: state },
  }));
}

/** Returns readiness for the registry layers a template mount can observe. */
export function webPluginMountState(
  mount: WebPluginMount,
  state: WebPluginCompositionState = webPluginCompositionStore.state,
): WebPluginMountState {
  const global = state.mounts.global ?? { phase: state.phase, error: state.error };
  if (mount.scope === 'global') return global;
  if (global.phase !== 'ready') return global;
  const workspace = state.mounts[`workspace:${mount.workspaceId}`];
  if (workspace === undefined) {
    if (state.phase === 'idle' || state.phase === 'loading') return { phase: 'loading' };
    return {
      phase: 'error',
      error: `No synchronized web composition exists for workspace:${mount.workspaceId}.`,
    };
  }
  if (mount.scope === 'workspace' || workspace.phase !== 'ready') return workspace;
  return state.mounts[`session:${mount.sessionId}`] ?? { phase: 'loading' };
}

async function readCompositions(): Promise<CompositionsResponse> {
  const response = await sealedHttpSession.fetch('/api/compositions', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load web compositions (${response.status}).`);
  return (await response.json()) as CompositionsResponse;
}

export function refreshWebPluginCompositions(): Promise<void> {
  if (pendingCompositionRefresh !== undefined) return pendingCompositionRefresh;
  setCompositionState({ phase: 'loading', error: undefined });
  setMountState('global', { phase: 'loading' });
  const epoch = runtimeEpoch;
  const refresh = (async () => {
    const metadata = await readCompositions();
    if (epoch !== runtimeEpoch) return;
    await bootstrapLocalVerifier(metadata.shell);
    if (epoch !== runtimeEpoch) return;
    await mountComposition({ scope: 'global' }, metadata.global);
    const errors: string[] = [];
    for (const workspace of metadata.workspaces) {
      if (epoch !== runtimeEpoch) return;
      try {
        await mountComposition({ scope: 'workspace', workspaceId: workspace.id }, workspace.webComposition);
      } catch (error) {
        // Each mount owns its error. Finish independent workspaces before reporting the refresh failure.
        errors.push(compositionError(error));
      }
    }
    if (epoch !== runtimeEpoch) return;
    const admitted = new Set(metadata.workspaces.map((workspace) => `workspace:${workspace.id}`));
    for (const key of Object.keys(webPluginCompositionStore.state.mounts))
      if (key.startsWith('workspace:') && !admitted.has(key)) {
        disposeMount(key);
        removeWorkspaceWebPlugins(key.slice('workspace:'.length));
        webPluginCompositionStore.setState((current) => {
          const mounts = { ...current.mounts };
          delete mounts[key];
          return { ...current, mounts };
        });
      }
    if (errors.length > 0) throw new Error(errors.join('; '));
  })();
  let pending: Promise<void>;
  pending = refresh
    .then(() => {
      if (epoch === runtimeEpoch) setCompositionState({ phase: 'ready', error: undefined });
    })
    .catch((error: unknown) => {
      if (epoch === runtimeEpoch) {
        const failure: WebPluginMountState = { phase: 'error', error: compositionError(error) };
        // Metadata and shell verification can fail before mountComposition gets to settle this state.
        if (webPluginCompositionStore.state.mounts.global?.phase === 'loading') setMountState('global', failure);
        setCompositionState(failure);
      }
      throw error;
    })
    .finally(() => {
      if (pendingCompositionRefresh === pending) pendingCompositionRefresh = undefined;
    });
  pendingCompositionRefresh = pending;
  return pending;
}

/** Retries composition delivery and restores the last requested session mount. */
export async function retryWebPluginCompositions(): Promise<void> {
  try {
    await refreshWebPluginCompositions();
  } catch (error) {
    const workspaceId = focusedSessionComposition?.workspaceId;
    if (workspaceId === undefined || webPluginMountState({ scope: 'workspace', workspaceId }).phase !== 'ready')
      throw error;
    // The focused workspace recovered even though another workspace failed.
  }
  const focused = focusedSessionComposition;
  if (focused === undefined || runtime === undefined) return;
  await focusSessionWebPlugins(focused.sessionId, focused.composition, focused.workspaceId);
}

export async function focusWorkspaceWebPlugins(workspaceId: string | null): Promise<void> {
  activateWebPluginWorkspace(workspaceId);
  if (!workspaceId) return;
  if (pendingCompositionRefresh !== undefined || !loadedMounts.has(`workspace:${workspaceId}`)) {
    try {
      await refreshWebPluginCompositions();
    } catch (error) {
      if (webPluginMountState({ scope: 'workspace', workspaceId }).phase !== 'ready') throw error;
      // A refresh failure in another workspace must not block this workspace's session mount.
    }
  }
  const readiness = webPluginMountState({ scope: 'workspace', workspaceId });
  if (readiness.phase === 'error') throw new Error(readiness.error);
}

/**
 * Session focus changes visibility; it does not destroy other mounts. Session store updates call this on every
 * change, so an unchanged focus reuses the previous request instead of writing mount state again.
 */
export function focusSessionWebPlugins(
  sessionId: string | null,
  composition: SessionWebComposition | undefined,
  workspaceId?: string,
): Promise<void> {
  const key = composition === undefined ? undefined : compositionKey(composition);
  const last = lastSessionFocus;
  if (
    sessionId !== null &&
    last?.sessionId === sessionId &&
    last.key === key &&
    last.workspaceId === workspaceId &&
    last.runtimeEpoch === runtimeEpoch &&
    last.ownerEpoch === (mountEpochs.get(`session:${sessionId}`) ?? 0)
  ) {
    activateWebPluginSession(sessionId);
    return last.promise;
  }
  const promise = focusSessionMount(sessionId, composition, workspaceId);
  lastSessionFocus =
    sessionId === null
      ? undefined
      : {
          sessionId,
          key,
          workspaceId,
          runtimeEpoch,
          ownerEpoch: mountEpochs.get(`session:${sessionId}`) ?? 0,
          promise,
        };
  void promise.catch(() => {
    // A failed focus must run again on the next request so retry and reconnect can remount.
    if (lastSessionFocus?.promise === promise) lastSessionFocus = undefined;
  });
  return promise;
}

async function focusSessionMount(
  sessionId: string | null,
  composition: SessionWebComposition | undefined,
  workspaceId?: string,
): Promise<void> {
  const epoch = ++focusEpoch;
  const runtimeAtStart = runtimeEpoch;
  focusedSessionComposition = sessionId === null ? undefined : { sessionId, composition, workspaceId };
  activateWebPluginSession(sessionId);
  if (!sessionId || !runtime) return;
  const owner = `session:${sessionId}`;
  const ownerEpoch = mountEpochs.get(owner) ?? 0;
  setMountState(owner, { phase: 'loading' });
  try {
    if (!workspaceId) throw new Error(`Session '${sessionId}' has no workspace identity.`);
    await focusWorkspaceWebPlugins(workspaceId);
    if (runtimeAtStart !== runtimeEpoch || ownerEpoch !== (mountEpochs.get(owner) ?? 0)) return;
    await mountComposition({ scope: 'session', sessionId, workspaceId }, composition);
    if (epoch === focusEpoch) activateWebPluginSession(sessionId);
  } catch (error) {
    if (epoch === focusEpoch && runtimeAtStart === runtimeEpoch) {
      setMountState(`session:${sessionId}`, { phase: 'error', error: compositionError(error) });
      setCompositionState({ phase: 'error', error: compositionError(error) });
    }
    throw error;
  }
}

export function removeSessionWebPluginRuntime(sessionId: string): void {
  focusEpoch += 1;
  if (focusedSessionComposition?.sessionId === sessionId) focusedSessionComposition = undefined;
  disposeMount(`session:${sessionId}`);
  setMountState(`session:${sessionId}`, { phase: 'idle' });
  removeSessionWebPlugins(sessionId);
}

/** Owns the three scope lifecycles for this transport connection. */
export function startSessionWebPluginRuntime(hostRuntime: WebPluginRuntime): () => void {
  runtimeEpoch += 1;
  pendingCompositionRefresh = undefined;
  runtime = hostRuntime;
  webPluginCompositionStore.setState(() => ({ phase: 'loading', mounts: {} }));
  const refresh = () => {
    void refreshWebPluginCompositions().catch((error: unknown) => console.error(error));
  };
  const unsubscribe = hostRuntime.onHubConnected(refresh);
  refresh();
  return () => {
    runtimeEpoch += 1;
    focusEpoch += 1;
    pendingCompositionRefresh = undefined;
    unsubscribe();
    for (const key of loadedMounts.keys()) {
      disposeMount(key);
      if (key.startsWith('session:')) removeSessionWebPlugins(key.slice('session:'.length));
      if (key.startsWith('workspace:')) removeWorkspaceWebPlugins(key.slice('workspace:'.length));
    }
    installGlobalWebPlugins([]);
    focusedSessionComposition = undefined;
    runtime = undefined;
    activateWebPluginSession(null);
    activateWebPluginWorkspace(null);
    webPluginCompositionStore.setState(() => ({ phase: 'idle', mounts: {} }));
  };
}
