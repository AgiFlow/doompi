type Frame = Record<string, unknown>;

export function promptCommand(message: string): Frame {
  return { type: 'prompt', message };
}

export function steerCommand(message: string): Frame {
  return { type: 'steer', message };
}

export function followUpCommand(message: string): Frame {
  return { type: 'follow_up', message };
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

export function dialogValue(id: string, value: string): Frame {
  return { type: 'extension_ui_response', id, value };
}

export function dialogConfirmed(id: string, confirmed: boolean): Frame {
  return { type: 'extension_ui_response', id, confirmed };
}

export function dialogCancelled(id: string): Frame {
  return { type: 'extension_ui_response', id, cancelled: true };
}
