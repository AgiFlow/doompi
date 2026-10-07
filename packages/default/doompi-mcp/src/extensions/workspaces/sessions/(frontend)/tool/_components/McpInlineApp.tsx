import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useStore } from '@tanstack/react-store';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type McpAppOpenResult, mcpAppRuntime } from '../_lib/mcpAppRuntime';
import { mcpAppCsp, mcpAppDocument, mcpAppRelayHtml, supportsMcpAppSandbox } from '../_lib/mcpAppSandbox';
import { mcpOpenAiScript } from '../_lib/mcpOpenAiBootstrap';

type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge['oncalltool']>>>;

const DEFAULT_HEIGHT = 320;
const MAX_HEIGHT = 1200;
const MIN_HEIGHT = 80;
const OPEN_TIMEOUT = 15_000;
const LEGACY_CHANNEL = 'doompi.openai';

function currentTheme(): 'light' | 'dark' {
  const scheme = document.documentElement.style.colorScheme;
  if (scheme === 'light' || scheme === 'dark') return scheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The MCP App could not complete this request';
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid App request');
  return value as Record<string, unknown>;
}

function invoke(runtime: WebPluginRuntime, sessionId: string, method: string, input: unknown): Promise<unknown> {
  return runtime.invokeServerMethod({ mount: { scope: 'session', sessionId }, service: 'mcp.apps', method, input });
}

async function openLink(value: unknown): Promise<Record<string, never>> {
  if (typeof value !== 'string') throw new Error('Invalid external link');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Only HTTPS external links are supported');
  if (!window.confirm(`Open this external link?\n${url.href}`)) throw new Error('Opening the link was declined');
  const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
  // noopener may deliberately return null, so it is not evidence of a blocked popup.
  if (opened !== null) opened.opener = null;
  return {};
}

interface FrameProps {
  runtime: WebPluginRuntime;
  sessionId: string;
  toolCallId: string;
  data: McpAppOpenResult;
  savedState: unknown;
  saveState: (state: unknown) => void;
  onClose: () => void;
}

function AppFrame({ runtime, sessionId, toolCallId, data, savedState, saveState, onClose }: FrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [initialState] = useState(() => savedState);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || frame.contentWindow === null) return;
    let live = true;
    let bridge: AppBridge | undefined;
    const channels = new MessageChannel();
    const request = (method: string, input: Record<string, unknown>) => {
      if (!live) return Promise.reject(new Error('MCP App is closed'));
      return invoke(runtime, sessionId, method, { ...input, leaseId: data.leaseId });
    };
    const resize = (value: unknown): void => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value))));
      }
    };
    const fail = (error: unknown): void => {
      if (!live) return;
      setFailure(errorText(error));
      live = false;
      frame.srcdoc = '';
      void requestCloseLease().catch((closeError: unknown) => {
        setFailure(`${errorText(error)}. Closing the App lease failed: ${errorText(closeError)}`);
      });
    };
    const requestCloseLease = (): Promise<unknown> => invoke(runtime, sessionId, 'close', { leaseId: data.leaseId });
    const timeout = window.setTimeout(() => fail(new Error('MCP App initialization timed out')), OPEN_TIMEOUT);
    const markReady = (): void => {
      if (!live) return;
      clearTimeout(timeout);
      setReady(true);
    };
    const callTool = async (name: unknown, args: unknown): Promise<CallToolResult> => {
      if (data.readOnly) throw new Error('Enable interactions in the conversation before calling tools');
      if (typeof name !== 'string') throw new Error('Invalid App tool name');
      const result = await request('callTool', { name, arguments: object(args ?? {}) });
      return result as CallToolResult;
    };
    const persist = async (state: unknown): Promise<Record<string, never>> => {
      await request('setState', { state });
      saveState(state);
      return {};
    };
    const followUp = async (prompt: unknown): Promise<Record<string, never>> => {
      if (data.readOnly) throw new Error('Enable interactions in the conversation before sending a follow-up');
      if (typeof prompt !== 'string') throw new Error('Invalid App follow-up');
      await request('followUp', { prompt });
      return {};
    };
    const close = async (): Promise<Record<string, never>> => {
      await request('close', {});
      onClose();
      return {};
    };
    const theme = currentTheme();
    const globals = {
      toolInput: data.args,
      toolOutput: data.result.structuredContent ?? null,
      toolResponseMetadata: data.result._meta ?? {},
      widgetState: initialState,
      theme,
      locale: navigator.language,
      displayMode: 'inline' as const,
      maxHeight: MAX_HEIGHT,
      safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } },
      userAgent: {
        device: { type: window.matchMedia('(pointer: coarse)').matches ? ('mobile' as const) : ('desktop' as const) },
        capabilities: { hover: window.matchMedia('(hover: hover)').matches, touch: navigator.maxTouchPoints > 0 },
      },
    };
    try {
      const policy = mcpAppCsp(data.resourceMeta, location.origin);
      if (data.protocol === 'mcp') {
        bridge = new AppBridge(
          null,
          { name: 'DoomPi', version: '1' },
          {
            ...(data.readOnly ? {} : { serverTools: {}, message: { text: {} } }),
            openLinks: {},
          },
          {
            hostContext: {
              theme,
              locale: navigator.language,
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              toolInfo: { id: toolCallId, tool: data.tool },
            },
          },
        );
        bridge.oncalltool = ({ name, arguments: args }) => callTool(name, args);
        bridge.onmessage = async ({ content }) => {
          if (content.some((block) => block.type !== 'text')) throw new Error('Only text follow-ups are supported');
          return followUp(content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));
        };
        bridge.onopenlink = ({ url }) => openLink(url);
        bridge.onsizechange = ({ height: next }) => resize(next);
        bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
        bridge.onrequestteardown = () => {
          void close().catch(fail);
        };
        bridge.oninitialized = () => {
          void (async () => {
            await bridge!.sendToolInput({ arguments: data.args });
            await bridge!.sendToolResult(data.result as CallToolResult);
            markReady();
          })().catch(fail);
        };
        void bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow)).catch(fail);
      }
      channels.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (!live) return;
        const message = event.data as { type?: string; data?: unknown };
        if (message?.type === 'revoked') {
          fail(new Error('MCP App navigation was blocked; reopen it to continue'));
          return;
        }
        if (message?.type !== 'legacy') return;
        const legacy = message.data as { channel?: string; id?: number; method?: string; input?: unknown } | null;
        if (legacy?.channel !== LEGACY_CHANNEL) return;
        void (async () => {
          const input = object(legacy.input ?? {});
          switch (legacy.method) {
            case 'initialized': {
              markReady();
              // A theme change while the App document loaded reached no listener; this one runs after it.
              const loadedTheme = currentTheme();
              if (loadedTheme !== theme)
                channels.port1.postMessage({ channel: LEGACY_CHANNEL, globals: { theme: loadedTheme } });
              return {};
            }
            case 'height':
              resize(input.height);
              return {};
            case 'callTool':
              return callTool(input.name, input.arguments);
            case 'setState':
              return persist(input.state);
            case 'followUp':
              return followUp(input.prompt);
            case 'openLink':
              return openLink(input.url);
            case 'close':
              return close();
            default:
              throw new Error('Unsupported ChatGPT widget method');
          }
        })().then(
          (result) => {
            if (!live || legacy.id === undefined) return;
            // A widget's own call returns its result; replacing the rendered tool's output corrupts widgets that persist it.
            const returned =
              legacy.method === 'callTool' && data.protocol === 'openai' ? (result as CallToolResult) : undefined;
            channels.port1.postMessage({
              channel: LEGACY_CHANNEL,
              id: legacy.id,
              result,
              ...(returned === undefined
                ? {}
                : {
                    globals: {
                      toolOutput: returned.structuredContent ?? null,
                      toolResponseMetadata: returned._meta ?? {},
                    },
                  }),
            });
          },
          (error: unknown) => {
            if (!live || legacy.id === undefined) return;
            channels.port1.postMessage({ channel: LEGACY_CHANNEL, id: legacy.id, error: errorText(error) });
          },
        );
      };
      channels.port1.start();
      const load = (): void => {
        frame.contentWindow?.postMessage(
          {
            html: mcpAppDocument(data.html, policy, mcpOpenAiScript(globals), theme),
            policy,
            protocol: data.protocol,
          },
          '*',
          [channels.port2],
        );
      };
      frame.addEventListener('load', load, { once: true });
      frame.srcdoc = mcpAppRelayHtml(policy, theme);
      const observer = new MutationObserver(() => {
        const nextTheme = currentTheme();
        bridge?.setHostContext({ theme: nextTheme });
        channels.port1.postMessage({ channel: LEGACY_CHANNEL, globals: { theme: nextTheme } });
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'style'],
      });
      return () => {
        live = false;
        clearTimeout(timeout);
        observer.disconnect();
        frame.removeEventListener('load', load);
        channels.port1.close();
        channels.port2.close();
        if (bridge !== undefined) void bridge.close().catch((error: unknown) => setFailure(errorText(error)));
        frame.srcdoc = '';
      };
    } catch (error) {
      fail(error);
      return () => {
        clearTimeout(timeout);
        channels.port1.close();
        channels.port2.close();
      };
    }
  }, [runtime, sessionId, toolCallId, data, initialState, saveState, onClose]);

  return (
    <div className="overflow-hidden rounded border border-doom-border-soft" data-testid="mcp-inline-app">
      {failure !== null ? (
        <p role="alert" className="p-3 text-doom-dim">
          {failure}
        </p>
      ) : null}
      {!ready && failure === null ? <output className="p-3 text-doom-faint">Loading MCP App…</output> : null}
      <iframe
        ref={frameRef}
        title={`${data.tool.name} MCP App`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        className={failure !== null ? 'hidden' : 'block w-full border-0'}
        style={{ height }}
      />
    </div>
  );
}

export function McpInlineApp({ sessionId, toolCallId }: { sessionId: string | null; toolCallId: string }) {
  const runtime = useStore(mcpAppRuntime.store, (state) => mcpAppRuntime.select(state, sessionId).runtime);
  const [data, setData] = useState<McpAppOpenResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [widgetState, setWidgetState] = useState<unknown>(null);
  const saveState = useCallback((value: unknown) => setWidgetState(value), []);
  const close = useCallback(() => setClosed(true), []);

  useEffect(() => {
    if (runtime === null || sessionId === null || !supportsMcpAppSandbox()) return;
    let mounted = true;
    let leaseId: string | undefined;
    void invoke(runtime, sessionId, 'open', { toolCallId })
      .then((response) => {
        const opened = response as McpAppOpenResult;
        leaseId = opened.leaseId;
        if (!mounted) return invoke(runtime, sessionId, 'close', { leaseId });
        setWidgetState(opened.state);
        setData(opened);
        return undefined;
      })
      .catch((error: unknown) => {
        if (mounted) setFailure(errorText(error));
      });
    return () => {
      mounted = false;
      if (leaseId !== undefined) {
        void invoke(runtime, sessionId, 'close', { leaseId }).catch((error: unknown) => setFailure(errorText(error)));
      }
    };
  }, [runtime, sessionId, toolCallId]);

  if (closed) return <p className="text-doom-faint">MCP App closed. Expand the card to view the tool result.</p>;
  if (!supportsMcpAppSandbox())
    return (
      <p className="text-doom-faint">
        This browser cannot securely display MCP Apps. Expand the card to view the tool result.
      </p>
    );
  if (failure !== null)
    return (
      <p role="alert" className="text-doom-dim">
        MCP App unavailable: {failure}
      </p>
    );
  if (runtime === null || sessionId === null)
    return (
      <p className="text-doom-faint">
        The interactive MCP App is unavailable in this view. Expand the card to view the tool result.
      </p>
    );
  if (data === null) return <output className="text-doom-faint">Loading MCP App…</output>;

  const activate = (): void => {
    setActivating(true);
    setActionFailure(null);
    void invoke(runtime, sessionId, 'activate', { leaseId: data.leaseId })
      .then(() => {
        setData({ ...data, readOnly: false });
      })
      .catch((error: unknown) => setActionFailure(errorText(error)))
      .finally(() => setActivating(false));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-doom-faint">
        <span>{data.readOnly ? 'Read-only MCP App' : 'MCP App interactions enabled'}</span>
        {data.readOnly ? (
          <button
            type="button"
            disabled={activating}
            onClick={activate}
            className="rounded border border-doom-border-soft px-2 py-1 text-doom-blue disabled:opacity-50"
          >
            {activating ? 'Enabling…' : 'Enable interactions'}
          </button>
        ) : null}
      </div>
      {actionFailure !== null ? (
        <p role="alert" className="text-doom-dim">
          {actionFailure}
        </p>
      ) : null}
      <AppFrame
        key={`${data.leaseId}-${String(data.readOnly)}`}
        runtime={runtime}
        sessionId={sessionId}
        toolCallId={toolCallId}
        data={data}
        savedState={widgetState}
        saveState={saveState}
        onClose={close}
      />
    </div>
  );
}
