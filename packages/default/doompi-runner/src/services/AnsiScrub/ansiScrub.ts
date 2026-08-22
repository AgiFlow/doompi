/**
 * Turns terminal output into text worth grepping.
 *
 * PTY output is written for a screen, not a file: colours, cursor moves and
 * carriage-return redraws all end up in the byte stream. Without this a single
 * progress bar becomes thousands of near-identical log lines.
 */

/**
 * CSI sequences (colours, cursor moves), OSC strings, the two-byte Fe escapes,
 * and the keypad-mode escapes shells emit around every prompt.
 */
const ANSI_PATTERN = new RegExp(
  [
    '\\u001B\\[[0-9;?]*[ -/]*[@-~]',
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
    '\\u001B[@-Z\\\\-_]',
    '\\u001B[=><]',
  ].join('|'),
  'g',
);

/** Bell and backspace, which a terminal consumes rather than displays. */
// oxlint-disable-next-line no-control-regex -- matching terminal control bytes is the whole job
const CONTROL_PATTERN = /[\u0007\u0008]/g;

/**
 * The same set minus SGR, the sequence that only sets colour and weight.
 *
 * The final byte class omits `m`, so `ESC[32m` survives while cursor moves,
 * OSC strings and keypad escapes are still removed.
 */
const ANSI_PATTERN_KEEPING_COLOUR = new RegExp(
  [
    '\\u001B\\[[0-9;?]*[ -/]*[@-ln-~]',
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
    '\\u001B[@-Z\\\\-_]',
    '\\u001B[=><]',
  ].join('|'),
  'g',
);

/** Removes escape sequences, leaving the characters a user would have seen. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

/**
 * Removes everything `stripAnsi` does except colour.
 *
 * Logs are read back by a terminal renderer as well as by grep, and a command
 * that colours its own output has already said how it should look.
 */
export function stripAnsiKeepingColour(text: string): string {
  return text.replace(ANSI_PATTERN_KEEPING_COLOUR, '').replace(CONTROL_PATTERN, '');
}

/**
 * Collapses carriage-return redraws.
 *
 * A bare `\r` returns the cursor to the start of the current line, so whatever
 * follows overwrites it. Only the final state of each line is kept. The `\r` of
 * a CRLF pair is a line terminator rather than a redraw, so it is normalised
 * away first: a pseudo terminal ends every line that way, and treating it as a
 * redraw would blank the whole log.
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.split('\r').at(-1) ?? '') : line))
    .join('\n');
}

/** Full scrub applied to PTY output before it reaches the log file. */
export function scrubTerminalOutput(text: string): string {
  return collapseCarriageReturns(stripAnsiKeepingColour(text));
}

/** Plain-text scrub, for the copy the model reads. */
export function scrubTerminalOutputToPlainText(text: string): string {
  return collapseCarriageReturns(stripAnsi(text));
}
