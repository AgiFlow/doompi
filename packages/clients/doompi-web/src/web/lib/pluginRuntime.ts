import * as TanstackReactStore from '@tanstack/react-store';
import * as TanstackStore from '@tanstack/store';
import * as WebComponents from '@agimon-ai/doompi-web-components';
import * as WebContracts from '@agimon-ai/doompi-web-contracts';
import * as WebSecurityBrowser from '@agimon-ai/doompi-web-security/browser';
import type { WebPluginDefinition, WebPluginRuntime, WebPluginMount } from '@agimon-ai/doompi-web-contracts';
import * as CodeMirrorState from '@codemirror/state';
import * as CodeMirrorView from '@codemirror/view';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { activateVerifiedPluginComposition } from '../../pwa/workerClient.ts';
import type { SessionWebComposition } from '../../types/hub.ts';
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
} from './pluginRegistry.ts';

import { verifiedDevComposition } from './verifiedDevComposition.ts';
import { pluginsAtScope } from './pluginScopes.ts';
import { sealedHttpSession } from './sealedSession.ts';

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
  workspaces: { id: string; webComposition?: SessionWebComposition }[];
}

const loadedMounts = new Map<string, LoadedComposition>();
const mountEpochs = new Map<string, number>();
const pendingMounts = new Map<string, Promise<void>>();
let runtime: WebPluginRuntime | undefined;
let runtimeEpoch = 0;
let focusEpoch = 0;
let scriptQueue: Promise<unknown> = Promise.resolve();

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
  if (!composition) throw new Error(`No synchronized web composition exists for ${mountKey(mount)}.`);
  const owner = mountKey(mount);
  const key = compositionKey(composition);
  const epoch = runtimeEpoch;
  const ownerEpoch = mountEpochs.get(owner) ?? 0;
  const stale = () => epoch !== runtimeEpoch || ownerEpoch !== (mountEpochs.get(owner) ?? 0);
  const replace = async () => {
    if (stale() || loadedMounts.get(owner)?.key === key) return;
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
  } finally {
    if (pendingMounts.get(owner) === pending) pendingMounts.delete(owner);
  }
}

async function readCompositions(): Promise<CompositionsResponse> {
  const response = await sealedHttpSession.fetch('/api/compositions', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load web compositions (${response.status}).`);
  return (await response.json()) as CompositionsResponse;
}

export async function refreshWebPluginCompositions(): Promise<void> {
  const metadata = await readCompositions();
  await mountComposition({ scope: 'global' }, metadata.global);
  for (const workspace of metadata.workspaces) {
    await mountComposition({ scope: 'workspace', workspaceId: workspace.id }, workspace.webComposition);
  }
  const admitted = new Set(metadata.workspaces.map((workspace) => `workspace:${workspace.id}`));
  for (const key of loadedMounts.keys())
    if (key.startsWith('workspace:') && !admitted.has(key)) {
      disposeMount(key);
      removeWorkspaceWebPlugins(key.slice('workspace:'.length));
    }
}

export async function focusWorkspaceWebPlugins(workspaceId: string | null): Promise<void> {
  activateWebPluginWorkspace(workspaceId);
  if (workspaceId && !loadedMounts.has(`workspace:${workspaceId}`)) await refreshWebPluginCompositions();
}

/** Session focus changes visibility; it does not destroy other mounts. */
export async function focusSessionWebPlugins(
  sessionId: string | null,
  composition: SessionWebComposition | undefined,
  workspaceId?: string,
): Promise<void> {
  const epoch = ++focusEpoch;
  activateWebPluginSession(sessionId);
  if (!sessionId || !runtime) return;
  if (!workspaceId) throw new Error(`Session '${sessionId}' has no workspace identity.`);
  await focusWorkspaceWebPlugins(workspaceId);
  await mountComposition({ scope: 'session', sessionId, workspaceId }, composition);
  if (epoch === focusEpoch) activateWebPluginSession(sessionId);
}

export function removeSessionWebPluginRuntime(sessionId: string): void {
  focusEpoch += 1;
  disposeMount(`session:${sessionId}`);
  removeSessionWebPlugins(sessionId);
}

/** Owns the three scope lifecycles for this transport connection. */
export function startSessionWebPluginRuntime(hostRuntime: WebPluginRuntime): () => void {
  runtime = hostRuntime;
  const refresh = () => {
    void refreshWebPluginCompositions().catch((error: unknown) => console.error(error));
  };
  const unsubscribe = hostRuntime.onHubConnected(refresh);
  refresh();
  return () => {
    runtimeEpoch += 1;
    focusEpoch += 1;
    unsubscribe();
    for (const key of loadedMounts.keys()) {
      disposeMount(key);
      if (key.startsWith('session:')) removeSessionWebPlugins(key.slice('session:'.length));
      if (key.startsWith('workspace:')) removeWorkspaceWebPlugins(key.slice('workspace:'.length));
    }
    installGlobalWebPlugins([]);
    runtime = undefined;
    activateWebPluginSession(null);
    activateWebPluginWorkspace(null);
  };
}
