type Frame = Record<string, unknown>;

export interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export function promptCommand(message: string, images: RpcImage[] = []): Frame {
  return { type: 'prompt', message, ...(images.length > 0 ? { images } : {}) };
}

export function steerCommand(message: string, images: RpcImage[] = []): Frame {
  return { type: 'steer', message, ...(images.length > 0 ? { images } : {}) };
}

export function followUpCommand(message: string, images: RpcImage[] = []): Frame {
  return { type: 'follow_up', message, ...(images.length > 0 ? { images } : {}) };
}

/** Requests in-place Pi session-tree navigation after the hub resolves the visible transcript id. */
export function rewindCommand(itemId: string): Frame {
  return { type: 'rewind', itemId };
}

export function abortCommand(): Frame {
  return { type: 'abort' };
}

export function clearQueueCommand(): Frame {
  return { type: 'clear_queue' };
}

export function getStateCommand(): Frame {
  return { type: 'get_state' };
}

export function getSessionStatsCommand(): Frame {
  return { type: 'get_session_stats' };
}

export function getCommandsCommand(): Frame {
  return { type: 'get_commands' };
}

export function compactCommand(customInstructions?: string): Frame {
  return { type: 'compact', ...(customInstructions === undefined ? {} : { customInstructions }) };
}

const COMPACT = 'compact';

/**
 * Pi's built-in slash commands that the cockpit can actually run.
 *
 * `get_commands` reports extension commands, prompt templates and skills, and
 * nothing else, so the built-ins never reach the palette on their own. Nor can
 * they be sent as prompts: `session.prompt` has no branch for them, and the
 * TUI runs them by matching the raw typed text, so a prompt-shaped `/compact`
 * arrives at the model as literal text. Each entry here therefore needs its
 * own RPC frame, which is why the list holds only what is wired below rather
 * than everything the TUI offers.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: COMPACT, description: 'Manually compact the session context' },
];

/**
 * The frame a typed built-in maps to, or undefined when the text is an
 * ordinary prompt. The argument is passed through, so `/compact keep the API
 * decisions` reaches Pi as its custom instruction.
 */
export function builtinCommandFrame(text: string): Frame | undefined {
  // Split on any whitespace, not a space: the composer folds text attachments
  // into the draft with newlines, so a space-only split reads the newline as
  // part of the command name and silently sends the whole thing to the model.
  const matched = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (matched?.[1] !== COMPACT) return undefined;
  const argument = (matched[2] ?? '').trim();
  return compactCommand(argument.length > 0 ? argument : undefined);
}
export function getAvailableModelsCommand(): Frame {
  return { type: 'get_available_models' };
}

export function getAvailableThinkingLevelsCommand(): Frame {
  return { type: 'get_available_thinking_levels' };
}

export function setModelCommand(provider: string, modelId: string): Frame {
  return { type: 'set_model', provider, modelId };
}

export function setThinkingLevelCommand(level: string): Frame {
  return { type: 'set_thinking_level', level };
}

export function setSessionNameCommand(name: string): Frame {
  return { type: 'set_session_name', name };
}

export function dialogValue(id: string, value: string): Frame {
  return { type: 'extension_ui_response', id, value };
}

export function dialogConfirmed(id: string, confirmed: boolean): Frame {
  return { type: 'extension_ui_response', id, confirmed };
}

export function dialogCancelled(id: string): Frame {
  return { type: 'extension_ui_response', id, cancelled: true };
}
