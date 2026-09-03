import * as TanstackReactStore from '@tanstack/react-store';
import * as TanstackStore from '@tanstack/store';
import * as WebComponents from '@agimon-ai/doompi-web-components';
import * as WebContracts from '@agimon-ai/doompi-web-contracts';
import * as WebSecurityBrowser from '@agimon-ai/doompi-web-security/browser';
import type { WebPluginDefinition, WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
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
  installedWebPlugins,
  removeSessionWebPlugins,
  startPluginDefinitions,
  startWebPlugins,
  webPluginDiagnostics,
} from './pluginRegistry.ts';

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

interface LoadedSessionComposition {
  key: string;
  plugins: readonly WebPluginDefinition[];
}

const loadedSessions = new Map<string, LoadedSessionComposition>();
let builtinPlugins: readonly WebPluginDefinition[] = [];
let runtime: WebPluginRuntime | undefined;
let activeSession: string | null = null;
let requestedSession: string | null | undefined;
let requestedKey: string | undefined;
let stopActivePlugins: (() => void) | undefined;
let activeStyles: HTMLLinkElement[] = [];
let activationEpoch = 0;
let scriptQueue: Promise<unknown> = Promise.resolve();

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

function disposeActivePlugins(): void {
  stopActivePlugins?.();
  stopActivePlugins = undefined;
  for (const style of activeStyles) style.remove();
  activeStyles = [];
  activeSession = null;
}

async function prepareStyles(composition: SessionWebComposition): Promise<HTMLLinkElement[]> {
  const links = composition.stylePaths.map((stylePath) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.media = 'not all';
    link.href = `${composition.verifiedAssetBaseUrl}${stylePath}`;
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

/** Focuses, verifies and activates exactly one session's client plugin composition. */
export async function focusSessionWebPlugins(
  sessionId: string | null,
  composition: SessionWebComposition | undefined,
): Promise<void> {
  const key = composition === undefined ? 'empty' : compositionKey(composition);
  if (sessionId === requestedSession && key === requestedKey) return;
  requestedSession = sessionId;
  requestedKey = key;
  const epoch = ++activationEpoch;
  const replacingActiveSession = sessionId !== null && activeSession === sessionId;
  if (!replacingActiveSession) {
    disposeActivePlugins();
    activateWebPluginSession(sessionId);
  }
  if (sessionId === null || runtime === undefined) return;

  const previous = loadedSessions.get(sessionId);
  let plugins = previous?.key === key ? previous.plugins : undefined;
  let preparedStyles: HTMLLinkElement[] = [];
  try {
    if (composition === undefined) {
      plugins ??= builtinPlugins;
    } else {
      const verified = await activateVerifiedPluginComposition(composition);
      if (!verified.ok) throw new Error(`The plugin composition was refused (${verified.code}): ${verified.message}`);
      if (epoch !== activationEpoch) return;
      plugins ??= await executeCompositionScript(`${composition.verifiedAssetBaseUrl}${composition.entryPath}`);
      if (epoch !== activationEpoch) return;
      preparedStyles = await prepareStyles(composition);
    }
  } catch (error) {
    for (const style of preparedStyles) style.remove();
    if (epoch === activationEpoch) {
      console.error(error instanceof Error ? error : new Error(String(error)));
      if (previous === undefined) installSessionWebPlugins(sessionId, []);
      requestedSession = undefined;
      requestedKey = undefined;
    }
    return;
  }
  if (epoch !== activationEpoch || plugins === undefined) {
    for (const style of preparedStyles) style.remove();
    return;
  }

  if (replacingActiveSession) disposeActivePlugins();
  if (previous === undefined || previous.key !== key) {
    if (previous !== undefined) removeSessionWebPlugins(sessionId);
    loadedSessions.set(sessionId, { key, plugins });
    installSessionWebPlugins(sessionId, plugins);
  }
  activateWebPluginSession(sessionId);
  reportDiagnostics();
  for (const style of preparedStyles) style.media = 'all';
  activeStyles = preparedStyles;
  stopActivePlugins = startPluginDefinitions(plugins, runtime);
  activeSession = sessionId;
}

/** Drops one removed session's runtime resources and registry references. */
export function removeSessionWebPluginRuntime(sessionId: string): void {
  if (sessionId === activeSession || sessionId === requestedSession) {
    activationEpoch += 1;
    disposeActivePlugins();
    requestedSession = undefined;
    requestedKey = undefined;
  }
  loadedSessions.delete(sessionId);
  removeSessionWebPlugins(sessionId);
}

/** Supplies the shell transport and owns all plugin runtime disposal. */
export function startSessionWebPluginRuntime(hostRuntime: WebPluginRuntime): () => void {
  runtime = hostRuntime;
  builtinPlugins = installedWebPlugins();
  stopActivePlugins = startWebPlugins(hostRuntime);
  return () => {
    activationEpoch += 1;
    disposeActivePlugins();
    requestedSession = undefined;
    requestedKey = undefined;
    for (const sessionId of loadedSessions.keys()) removeSessionWebPlugins(sessionId);
    loadedSessions.clear();
    builtinPlugins = [];
    runtime = undefined;
    activateWebPluginSession(null);
  };
}
