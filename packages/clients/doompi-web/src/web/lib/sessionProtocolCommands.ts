import type {
  ImageContentPart,
  SessionMessageArgs,
  SessionService,
  ThinkingLevel,
} from '@agimon-ai/doompi-core/sessionProtocol';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';

type Frame = Record<string, unknown>;
const senders = new Map<string, (frame: Frame) => void>();
const releases = new Map<string, () => void>();
type CommandResponse = { success: boolean; data?: unknown; error?: string };
const requesters = new Map<string, (frame: Frame) => Promise<CommandResponse>>();
let requestSequence = 0;
const PARALLEL_COMMANDS = new Set([
  'compact',
  'abort',
  'resume_queue',
  'extension_ui_response',
  'get_commands',
  'get_available_models',
  'get_available_thinking_levels',
]);

export function bindSessionProtocol(
  sessionId: string,
  service: SessionService,
  receive: (frame: Frame) => void,
): () => void {
  let settled = Promise.resolve();
  let active = true;
  const acknowledgements = new Map<string, (response: CommandResponse) => void>();
  const lifetime = withCancel(BACKGROUND_CONTEXT);
  const text = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('Expected command text.');
    return value;
  };
  const images = (value: unknown): ImageContentPart[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error('Invalid command images.');
    return value.map((image: unknown) => {
      if (
        !image ||
        typeof image !== 'object' ||
        !('type' in image) ||
        image.type !== 'image' ||
        !('data' in image) ||
        !('mimeType' in image)
      )
        throw new Error('Invalid command image.');
      return { type: 'image', data: text(image.data), mimeType: text(image.mimeType) };
    });
  };
  const messageArgs = (frame: Frame): SessionMessageArgs => {
    const parsedImages = images(frame.images);
    return {
      text: text(frame.message),
      ...(parsedImages === undefined ? {} : { images: parsedImages }),
    };
  };
  const invoke = async (frame: Frame, context: typeof BACKGROUND_CONTEXT): Promise<unknown> => {
    context.abortSignal?.throwIfAborted();
    switch (frame.type) {
      case 'prompt':
        // An accepted prompt owns the agent turn. Its context must outlive a
        // focused-session replacement so leaving the page cannot abort Pi.
        return service.prompt({ ...messageArgs(frame), waitFor: 'accepted' }, BACKGROUND_CONTEXT);
      case 'steer':
        return service.steer(messageArgs(frame), context);
      case 'follow_up':
        return service.followUp(messageArgs(frame), context);
      case 'enqueue_automatic':
        return service.enqueueAutomatic(messageArgs(frame), context);
      case 'remove_queued':
        return service.removeQueued({ id: text(frame.id) }, context);
      case 'promote_queued':
        return service.promoteQueued({ id: text(frame.id), operationId: text(frame.operationId) }, context);
      case 'resume_queue':
        return service.resumeQueue(context);
      case 'abort':
        return typeof frame.operationId === 'string'
          ? service.abortOperation({ operationId: frame.operationId }, context)
          : service.abort(context);
      case 'clear_queue':
        return service.clearQueue(context);
      case 'rewind':
        return service.rewind({ itemId: text(frame.itemId) }, context);
      case 'compact':
        return service.compact(
          frame.customInstructions === undefined ? {} : { customInstructions: text(frame.customInstructions) },
          context,
        );
      case 'set_session_name':
        return service.setName(text(frame.name), context);
      case 'set_model':
        return service.setModel({ provider: text(frame.provider), id: text(frame.modelId) }, context);
      case 'set_thinking_level': {
        const level = text(frame.level);
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level))
          throw new Error('Invalid thinking level.');
        return service.setThinking(level as ThinkingLevel, context);
      }
      case 'extension_ui_response': {
        const id = text(frame.id);
        if (frame.cancelled === true) return service.extensionUiResponse({ id, cancelled: true }, context);
        if (typeof frame.confirmed === 'boolean')
          return service.extensionUiResponse({ id, confirmed: frame.confirmed }, context);
        return service.extensionUiResponse({ id, value: text(frame.value) }, context);
      }
      case 'get_state':
        return service.getState(context);
      case 'get_session_stats':
        return service.getSessionStats(context);
      case 'get_commands':
        return { commands: await service.getCommands(context) };
      case 'get_available_models':
        return { models: await service.getAvailableModels(context) };
      case 'get_available_thinking_levels':
        return { levels: await service.getAvailableThinkingLevels(context) };
      default:
        throw new Error(`Unsupported session command: ${String(frame.type)}`);
    }
  };
  const sender = (frame: Frame) => {
    const execute = async (context: typeof BACKGROUND_CONTEXT) => {
      if (!active) return;
      let response: CommandResponse;
      try {
        response = { success: true, data: await invoke(frame, context) };
      } catch (error) {
        response = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!active) return;
      receive({ type: 'response', id: frame.requestId ?? frame.id, command: frame.type, ...response });
      if (typeof frame.requestId === 'string') {
        acknowledgements.get(frame.requestId)?.(response);
        acknowledgements.delete(frame.requestId);
      }
    };
    // Long-running turns must never block the abort or dialog response that can release them.
    if (frame.type === 'prompt') void execute(BACKGROUND_CONTEXT);
    else if (PARALLEL_COMMANDS.has(String(frame.type))) void execute(lifetime.context);
    else settled = settled.then(() => execute(lifetime.context));
  };
  const request = (frame: Frame): Promise<CommandResponse> => {
    const requestId = `${sessionId}:${String(++requestSequence)}`;
    return new Promise((resolve) => {
      acknowledgements.set(requestId, resolve);
      sender({ ...frame, requestId });
    });
  };
  const release = () => {
    if (senders.get(sessionId) !== sender) return;
    active = false;
    for (const resolve of acknowledgements.values())
      resolve({
        success: false,
        error: 'Delivery uncertain: the session connection was replaced. Check the queue before resending.',
      });
    acknowledgements.clear();
    lifetime.cancel(new Error('The session protocol binding was replaced.'));
    senders.delete(sessionId);
    requesters.delete(sessionId);
    releases.delete(sessionId);
  };
  releases.get(sessionId)?.();
  senders.set(sessionId, sender);
  requesters.set(sessionId, request);
  releases.set(sessionId, release);
  return release;
}

export function hasSessionProtocol(sessionId: string): boolean {
  return senders.has(sessionId);
}

export function sendSessionProtocolFrame(sessionId: string, frame: Frame): void {
  const sender = senders.get(sessionId);
  if (!sender) throw new Error('The session protocol is not connected.');
  sender(frame);
}

/** Await admission without equating its response with native input consumption. */
export function requestSessionProtocolFrame(sessionId: string, frame: Frame): Promise<CommandResponse> {
  const request = requesters.get(sessionId);
  if (!request) return Promise.resolve({ success: false, error: 'The session protocol is not connected.' });
  return request(frame);
}
