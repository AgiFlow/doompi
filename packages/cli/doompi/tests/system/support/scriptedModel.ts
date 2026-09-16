import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenAI-compatible model that answers from a script.
 *
 * `ollamaProvider.ts` registers a provider with `api: "openai-completions"`
 * whose base URL is `DOOMPI_OLLAMA_BASE_URL`. Going through the launcher, the
 * variable to set is `OLLAMA_BASE_URL`: `harnessContext.ts` derives the former
 * from the latter and overwrites whatever was passed in directly. Either way
 * the whole real stack runs, the launcher, the composition, Pi and every
 * DoomPi extension, against a model that cannot vary: no network, no cost, and
 * the same answer every run.
 *
 * What it records is as useful as what it returns. The request carries the tool
 * list Pi advertised, which is the composition's own account of itself: if the
 * extensions loaded, their tools are in there, and no log parsing is needed to
 * find out.
 */

/** One scripted reply. Each request consumes the next, and the last one repeats. */
export interface ScriptedReply {
  /** Assistant text. Omit when the turn is only a tool call. */
  content?: string;
  /** Tools to call before answering; the agent runs them and asks again. */
  toolCalls?: readonly ScriptedToolCall[];
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  /** Arguments as the model would emit them, already an object. */
  arguments: Record<string, unknown>;
}

/** One request as the server received it. */
export interface ModelRequest {
  model: string;
  stream: boolean;
  /** Tool names Pi advertised, which is what the composition produced. */
  toolNames: string[];
  messages: Array<{ role: string; content: unknown }>;
  /** The raw body, for an assertion this shape does not cover. */
  body: Record<string, unknown>;
}

export interface ScriptedModel {
  /** The base URL to hand the launcher as OLLAMA_BASE_URL. */
  readonly baseUrl: string;
  /** Every request, in order. */
  readonly requests: readonly ModelRequest[];
  /** Waits until the server has answered this many requests. */
  waitForRequests(count: number, timeoutMs?: number): Promise<readonly ModelRequest[]>;
  close(): Promise<void>;
}

const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 25;
const MODEL_FALLBACK = 'scripted';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tool names in a chat-completions request, however sparse the payload is. */
function toolNamesOf(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool) => {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined;
    return typeof fn?.name === 'string' ? [fn.name] : [];
  });
}

function messagesOf(body: Record<string, unknown>): Array<{ role: string; content: unknown }> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) =>
    isRecord(message) && typeof message.role === 'string' ? [{ role: message.role, content: message.content }] : [],
  );
}

/** One reply as a non-streaming chat completion. */
function completionBody(reply: ScriptedReply, model: string): Record<string, unknown> {
  const toolCalls = (reply.toolCalls ?? []).map((call, index) => ({
    id: call.id,
    type: 'function',
    index,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return {
    id: 'scripted-completion',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.content ?? '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** The same reply as the SSE stream the client asks for with `stream: true`. */
function streamChunks(reply: ScriptedReply, model: string): string {
  const base = { id: 'scripted-completion', object: 'chat.completion.chunk', created: 0, model };
  const events: string[] = [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] })}`,
  ];
  if (reply.content) {
    events.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: reply.content } }] })}`);
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    const delta = {
      tool_calls: [
        {
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        },
      ],
    };
    events.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}`);
  });
  const finish = (reply.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop';
  events.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`);
  events.push('data: [DONE]');
  return `${events.join('\n\n')}\n\n`;
}

async function readBody(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A body this cannot parse is still a request worth recording; the test
    // asserting on it will say more than a parse error here would.
    return {};
  }
}

/**
 * Starts the scripted model and returns once it is listening.
 *
 * Replies are consumed in order; the last one repeats, so a script does not
 * have to predict how many turns the agent takes to settle.
 */
export async function startScriptedModel(script: readonly ScriptedReply[]): Promise<ScriptedModel> {
  const requests: ModelRequest[] = [];
  let answered = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const model = typeof body.model === 'string' ? body.model : MODEL_FALLBACK;
      const stream = body.stream === true;
      requests.push({ model, stream, toolNames: toolNamesOf(body), messages: messagesOf(body), body });
      const reply = script[Math.min(answered, script.length - 1)] ?? { content: '' };
      answered += 1;

      if (stream) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.end(streamChunks(reply, model));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(reply, model)));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    async waitForRequests(count, timeoutMs = DEFAULT_WAIT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `The scripted model saw ${String(requests.length)} of ${String(count)} requests before its ${String(timeoutMs)}ms budget.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
