import { randomUUID } from 'node:crypto';

import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import type { DoomPluginCaller } from '@agimon-ai/doompi-core/pluginProtocol';
import { defineServerMethod } from '@agimon-ai/doompi-core/serverFacet';

import {
  mcpAppActivateMethod,
  mcpAppCallToolMethod,
  mcpAppCloseMethod,
  mcpAppFollowUpMethod,
  mcpAppOpenMethod,
  type McpAppOpenResult,
  mcpAppSetStateMethod,
} from '../../schemas/mcpApps';
import { isAppVisibleMcpTool, normalizeMcpAppMetadata } from '../mcpCatalog';
import type { McpSessionToolsService } from '../mcpSessionTools';
import { parseMcpAppSnapshot } from '../mcpTools';

const STATE_ENTRY = 'mcp.app.state';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_LEASES = 64;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedJson<T>(value: T, limit: number, label: string): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > limit) throw new Error(`${label} exceeds its size limit.`);
  return JSON.parse(encoded) as T;
}

interface Lease {
  id: string;
  connectionId: string;
  host: DoomHeadlessHostService;
  toolCallId: string;
  server: string;
  tool: string;
  resourceUri: string;
  revision: number;
  runtimeRevision: number;
  controller: AbortController;
  signal: AbortSignal;
  readOnly: boolean;
  busy: boolean;
  actions: number;
}

/** Browser inputs identify a persisted invocation, never an upstream server or resource. */
export function createMcpAppsService(
  tools: McpSessionToolsService,
  getHost: () => DoomHeadlessHostService | undefined,
  lifetime?: AbortSignal,
) {
  const leases = new Map<string, Lease>();
  let disposed = false;
  let opening = 0;

  const revoke = (lease: Lease) => {
    leases.delete(lease.id);
    lease.controller.abort();
  };
  const check = (lease: Lease) => {
    lease.signal.throwIfAborted();
    if (disposed || getHost() !== lease.host) throw new Error('App session is no longer available.');
    lease.host.assertActive();
    const surface = lease.host.toolSurface;
    const current = surface?.readSurface();
    if (!surface || current?.revision !== lease.revision || tools.runtimeRevision() !== lease.runtimeRevision)
      throw new Error('App permissions changed. Reopen the App.');
    const source = tools.snapshot().find((tool) => tool.serverName === lease.server && tool.toolName === lease.tool);
    if (!source || normalizeMcpAppMetadata(source._meta).resourceUri !== lease.resourceUri)
      throw new Error('App resource is no longer available.');
    if (!current.tools.some((tool) => tool.name === source.piName || tool.name === 'mcp'))
      throw new Error('The original App tool is not admitted in this session.');
    return surface;
  };
  const owned = (id: string, caller: DoomPluginCaller) => {
    caller.signal?.throwIfAborted();
    const lease = leases.get(id);
    if (!lease || !caller.connectionId || lease.connectionId !== caller.connectionId)
      throw new Error('App lease is not owned by this connection.');
    try {
      check(lease);
    } catch (error) {
      revoke(lease);
      throw error;
    }
    return lease;
  };
  const operation = async <T>(
    id: string,
    caller: DoomPluginCaller,
    write: boolean,
    run: (lease: Lease) => Promise<T>,
  ) => {
    const lease = owned(id, caller);
    if (write && lease.readOnly) throw new Error('Enable App interactions before performing this action.');
    if (lease.busy) throw new Error('An App action is already in progress.');
    if (++lease.actions > 256) throw new Error('App action limit reached. Reopen the App.');
    lease.busy = true;
    try {
      return await run(lease);
    } finally {
      lease.busy = false;
    }
  };
  const confirm = async (lease: Lease, title: string, message: string) => {
    check(lease);
    const accepted = await lease.host.context.client.request(
      { kind: 'confirm', title, message },
      AbortSignal.any([lease.signal, AbortSignal.timeout(120_000)]),
    );
    check(lease);
    if (accepted !== true) throw new Error('App action was not approved.');
  };
  const invocation = async (host: DoomHeadlessHostService, toolCallId: string) => {
    const entries = await host.context.session.entries({ type: 'message' });
    let call: Record<string, unknown> | undefined;
    let result: Record<string, unknown> | undefined;
    for (const entry of entries) {
      const message = record(entry.message);
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          const candidate = record(block);
          if (candidate?.type === 'toolCall' && candidate.id === toolCallId) call = candidate;
        }
      }
      if (message?.role === 'toolResult' && message.toolCallId === toolCallId) result = message;
    }
    const details = record(result?.details);
    const app = parseMcpAppSnapshot(details?.app);
    if (
      !call ||
      !app?.resourceUri ||
      !app.protocol ||
      typeof details?.server !== 'string' ||
      typeof details.tool !== 'string'
    )
      throw new Error('This invocation has no retained App result.');
    return { call, details, app };
  };

  const stopTools = tools.onChange(() => {
    for (const lease of leases.values()) {
      try {
        check(lease);
      } catch {
        revoke(lease);
      }
    }
  });
  const dispose = () => {
    disposed = true;
    stopTools();
    for (const lease of leases.values()) revoke(lease);
  };
  lifetime?.addEventListener('abort', dispose, { once: true });

  return {
    dispose,
    methods: [
      defineServerMethod(mcpAppOpenMethod, async ({ toolCallId }, caller): Promise<McpAppOpenResult> => {
        if (!caller.connectionId || !caller.signal) throw new Error('An authenticated live connection is required.');
        caller.signal.throwIfAborted();
        if (disposed || lifetime?.aborted) throw new Error('App session is no longer available.');
        if (leases.size + opening >= MAX_LEASES)
          throw new Error('Too many open Apps. Close an App before opening another.');
        opening++;
        try {
          const host = getHost();
          if (!host?.toolSurface) throw new Error('App execution is unavailable in this session.');
          host.assertActive();
          const revision = host.toolSurface.readSurface().revision;
          const runtimeRevision = tools.runtimeRevision();
          const { call, details, app } = await invocation(host, toolCallId);
          const source = tools
            .snapshot()
            .find((tool) => tool.serverName === details.server && tool.toolName === details.tool);
          const declared = normalizeMcpAppMetadata(source?._meta);
          if (!source || declared.resourceUri !== app.resourceUri || declared.protocol !== app.protocol)
            throw new Error('The original App resource is no longer declared.');
          const args = record(call.arguments) ?? {};
          const generic = call.name === 'mcp' && args.server === source.serverName && args.tool === source.toolName;
          if (call.name !== source.piName && !generic)
            throw new Error('App invocation identity does not match its tool.');
          const controller = new AbortController();
          const lease: Lease = {
            id: randomUUID(),
            connectionId: caller.connectionId,
            host,
            toolCallId,
            server: source.serverName,
            tool: source.toolName,
            resourceUri: app.resourceUri!,
            revision,
            runtimeRevision,
            controller,
            signal: AbortSignal.any([controller.signal, caller.signal, ...(lifetime ? [lifetime] : [])]),
            readOnly: true,
            busy: false,
            actions: 0,
          };
          check(lease);
          const resource = await tools.readAppResource(lease.server, lease.tool, lease.resourceUri, lease.signal);
          check(lease);
          const content = resource.contents.find((item) => item.uri === lease.resourceUri && 'text' in item);
          if (!content || !('text' in content) || typeof content.text !== 'string')
            throw new Error('App resource must contain HTML text.');
          if (content.mimeType !== 'text/html;profile=mcp-app' && content.mimeType !== 'text/html+skybridge')
            throw new Error('Unsupported App resource MIME type.');
          if (Buffer.byteLength(content.text) > MAX_HTML_BYTES) throw new Error('App HTML exceeds its size limit.');
          const states = await host.context.session.entries({ type: 'custom', customType: STATE_ENTRY });
          let state: unknown = null;
          for (const entry of states) {
            const data = record(entry.data);
            if (
              data?.version === 1 &&
              data.toolCallId === toolCallId &&
              data.server === lease.server &&
              data.tool === lease.tool &&
              data.resourceUri === lease.resourceUri
            )
              state = data.state ?? null;
          }
          check(lease);
          if (leases.size >= MAX_LEASES) throw new Error('Too many open Apps.');
          const opened: McpAppOpenResult = {
            leaseId: lease.id,
            html: content.text,
            resourceUri: lease.resourceUri,
            protocol: app.protocol!,
            resourceMeta: boundedJson(
              record(content._meta) ?? record(resource._meta) ?? {},
              MAX_STATE_BYTES,
              'Resource metadata',
            ),
            tool: {
              name: source.toolName,
              description: source.description ?? '',
              inputSchema: boundedJson(
                { ...source.inputSchema, type: 'object' as const },
                MAX_STATE_BYTES,
                'Tool schema',
              ),
              _meta: boundedJson(source._meta ?? {}, MAX_STATE_BYTES, 'Tool metadata'),
            },
            args: boundedJson(generic ? (record(args.arguments) ?? {}) : args, MAX_STATE_BYTES, 'Tool input'),
            result: app.result,
            state: boundedJson(state, MAX_STATE_BYTES, 'App state'),
            readOnly: true,
          };
          leases.set(lease.id, lease);
          lease.signal.addEventListener('abort', () => leases.delete(lease.id), { once: true });
          return opened;
        } finally {
          opening--;
        }
      }),
      defineServerMethod(mcpAppActivateMethod, ({ leaseId }, caller) =>
        operation(leaseId, caller, false, async (lease) => {
          await confirm(
            lease,
            `Enable ${lease.server} App interactions?`,
            'This App may request tool calls and follow-up messages. Each action still requires approval.',
          );
          lease.readOnly = false;
          return { readOnly: false as const };
        }),
      ),
      defineServerMethod(mcpAppCallToolMethod, ({ leaseId, name, arguments: args }, caller) =>
        operation(leaseId, caller, true, async (lease) => {
          boundedJson(args, MAX_STATE_BYTES, 'Tool arguments');
          const target = tools
            .snapshot()
            .find((tool) => tool.serverName === lease.server && tool.toolName === name && isAppVisibleMcpTool(tool));
          if (!target) throw new Error('This tool is not available to this App.');
          const surface = check(lease);
          const exposed = surface.readSurface().tools;
          const direct = exposed.some((tool) => tool.name === target.piName);
          if (!direct && !exposed.some((tool) => tool.name === 'mcp'))
            throw new Error('This tool is not admitted in this session.');
          await confirm(lease, `Allow ${lease.server} App to call ${name}?`, JSON.stringify(args, null, 2));
          const result = await surface.invokeTool({
            revision: lease.revision,
            name: direct ? target.piName : 'mcp',
            arguments: direct ? args : { server: lease.server, tool: name, arguments: args },
            signal: AbortSignal.any([lease.signal, AbortSignal.timeout(120_000)]),
            authorize: () => {
              check(lease);
            },
          });
          check(lease);
          const retained = parseMcpAppSnapshot(record(result.details)?.app);
          return (
            retained?.result ??
            boundedJson(
              {
                content: result.content,
                ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
                ...(result._meta === undefined ? {} : { _meta: result._meta }),
                ...(result.isError === undefined ? {} : { isError: result.isError }),
              },
              MAX_RESULT_BYTES,
              'Tool result',
            )
          );
        }),
      ),
      defineServerMethod(mcpAppSetStateMethod, ({ leaseId, state }, caller) =>
        operation(leaseId, caller, false, async (lease) => {
          const saved = boundedJson(state, MAX_STATE_BYTES, 'App state');
          await lease.host.context.session.appendCustomEntry(STATE_ENTRY, {
            version: 1,
            toolCallId: lease.toolCallId,
            server: lease.server,
            tool: lease.tool,
            resourceUri: lease.resourceUri,
            state: saved,
          });
          check(lease);
          return {};
        }),
      ),
      defineServerMethod(mcpAppFollowUpMethod, ({ leaseId, prompt }, caller) =>
        operation(leaseId, caller, true, async (lease) => {
          const session = lease.host.context.session;
          if (!session.admitPrompt) throw new Error('App follow-up messages are unavailable in this session.');
          await confirm(lease, `Send a follow-up from ${lease.server}?`, prompt);
          await session.admitPrompt(
            `[MCP App ${lease.server}/${lease.tool}, invocation ${lease.toolCallId}]\n${prompt}`,
            'followUp',
          );
          check(lease);
          return {};
        }),
      ),
      defineServerMethod(mcpAppCloseMethod, ({ leaseId }, caller) => {
        const lease = leases.get(leaseId);
        if (lease && lease.connectionId !== caller.connectionId)
          throw new Error('App lease is not owned by this connection.');
        if (lease) revoke(lease);
        return {};
      }),
    ],
  };
}
