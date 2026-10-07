import type { DoomSharedFile } from '@agimon-ai/doompi-core/packageApi';

import type {
  McpConsentedFilePublisherOptions,
  McpFileParamTool,
  McpFileParamValue,
  McpFilePublisher,
  McpFileShareAudit,
  McpPublishedFileParams,
} from './type';

/** ChatGPT Apps metadata naming the top-level arguments that carry a file. */
const FILE_PARAMS_META_KEY = 'openai/fileParams';
const MAX_FILE_PARAMS = 16;
const FILE_ID_PREFIX = 'doomfile_';
const FILE_SHARE_ENTRY_TYPE = 'mcp.file.share';
const CONSENT_TIMEOUT_MS = 120_000;
const NO_PUBLISHER = 'This MCP tool takes a file, which needs the DoomPi web host with remote access on.';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function filePath(value: unknown): string | undefined {
  const path = record(value)?.path;
  return typeof path === 'string' ? path : undefined;
}

/** Declared file parameters that the input schema really has at its top level. */
export function fileParamNames(tool: Pick<McpFileParamTool, 'inputSchema' | '_meta'>): string[] {
  const declared = tool._meta?.[FILE_PARAMS_META_KEY];
  const properties = record(tool.inputSchema.properties);
  if (!Array.isArray(declared) || properties === undefined) return [];
  const names = declared.filter((name): name is string => typeof name === 'string' && Object.hasOwn(properties, name));
  return [...new Set(names)].slice(0, MAX_FILE_PARAMS);
}

/** What the model is asked for: a `{path}` object in place of each server file shape. */
export function modelInputSchema(tool: Pick<McpFileParamTool, 'inputSchema' | '_meta'>): Record<string, unknown> {
  // Pi requires a schema; a downstream tool that declares none takes any object.
  if (Object.keys(tool.inputSchema).length === 0) return { type: 'object', properties: {} };
  const names = fileParamNames(tool);
  if (names.length === 0) return tool.inputSchema;
  const properties = { ...record(tool.inputSchema.properties) };
  for (const name of names) {
    const description = record(properties[name])?.description;
    properties[name] = {
      type: 'object',
      description: `${typeof description === 'string' ? description : 'A file.'} Pass {"path": "<file in the working directory, or the path from an Attached file note>"}.`,
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    };
  }
  return { ...tool.inputSchema, properties };
}

/**
 * Swaps each `{path}` file argument for a published link, on a copy.
 *
 * Runs before the server is dialled, so a refused share never reaches it. Values that
 * are not `{path}` objects pass through, including a file a widget already shaped.
 */
export async function publishFileParams(
  tool: Pick<McpFileParamTool, 'inputSchema' | '_meta'>,
  params: Record<string, unknown>,
  publish?: (path: string) => Promise<DoomSharedFile>,
): Promise<McpPublishedFileParams> {
  const names = fileParamNames(tool).filter((name) => filePath(params[name]) !== undefined);
  if (names.length === 0) return { outbound: params, release: () => undefined };
  if (publish === undefined) throw new Error(NO_PUBLISHER);
  const outbound = { ...params };
  const shared: DoomSharedFile[] = [];
  const release = () => {
    for (const file of shared.splice(0)) file.revoke();
  };
  try {
    for (const name of names) {
      const file = await publish(filePath(params[name])!);
      shared.push(file);
      outbound[name] = {
        file_id: `${FILE_ID_PREFIX}${crypto.randomUUID()}`,
        download_url: file.url,
        file_name: file.fileName,
        mime_type: file.mimeType,
      } satisfies McpFileParamValue;
    }
  } catch (error) {
    release();
    throw error;
  }
  return { outbound, release };
}

/**
 * Publishes a file only after the user approves it for this server and tool.
 *
 * The host mints first so the dialog can name the file and its size; the link leaves
 * this function only on approval. No client, no answer within two minutes, a
 * cancelled call, or a failed audit all revoke it.
 */
export function createConsentedFilePublisher(options: McpConsentedFilePublisherOptions): McpFilePublisher {
  return async (path, tool, signal) => {
    const label = `${tool.serverName} / ${tool.toolName}`;
    const shared = await options.shareFile(path, label);
    try {
      const host = options.host();
      if (host === undefined) throw new Error(`There is no DoomPi client to approve sharing "${shared.fileName}".`);
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error('No answer within two minutes.')), CONSENT_TIMEOUT_MS);
      const abort = AbortSignal.any(
        [deadline.signal, signal, options.signal].filter(
          (candidate): candidate is AbortSignal => candidate !== undefined,
        ),
      );
      // Settles on abort even when a client ignores the signal it was given.
      const abandoned = new Promise<never>((_resolve, reject) => {
        if (abort.aborted) reject(abort.reason);
        abort.addEventListener('abort', () => reject(abort.reason), { once: true });
      });
      const answer = await Promise.race([
        host.context.client.request(
          {
            kind: 'confirm',
            title: 'Share a file with an MCP server?',
            message: `Share "${shared.fileName}" (${shared.size} bytes) with ${label}? DoomPi publishes it at a link on your remote-access tunnel until this call finishes (10 minutes at most). Cloudflare and ${tool.serverName} can read the file.`,
          },
          abort,
        ),
        abandoned,
      ])
        // A timeout, a cancelled call, or a lost client is an answer: not approved.
        .then(
          (accepted): McpFileShareAudit['outcome'] => (accepted === true ? 'shared' : 'declined'),
          (): McpFileShareAudit['outcome'] => 'unanswered',
        )
        .finally(() => clearTimeout(timer));
      await host.context.session.appendCustomEntry(FILE_SHARE_ENTRY_TYPE, {
        file: shared.fileName,
        server: tool.serverName,
        tool: tool.toolName,
        outcome: answer,
      } satisfies McpFileShareAudit);
      if (answer !== 'shared') throw new Error(`The user declined to share "${shared.fileName}".`);
      return shared;
    } catch (error) {
      shared.revoke();
      throw error;
    }
  };
}
