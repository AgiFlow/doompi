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

export function abortCommand(): Frame {
  return { type: 'abort' };
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
