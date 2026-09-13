export const ELLIPSIS = '…';
export const GAP = ' … ';
export const MAX_COMMAND_LENGTH = 160;
export const COLLAPSED_TAIL_LINES = 12;
export const STREAM_TAIL_LINES = 12;
// oxlint-disable-next-line no-control-regex -- matching SGR requires the ESC control character
export const SGR_PATTERN = /\u001b\[[0-9;]*m/;
