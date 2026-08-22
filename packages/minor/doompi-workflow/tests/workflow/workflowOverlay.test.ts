import { describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_ESCAPE_WINDOW_MS,
  DoubleEscapeDetector,
  TerminalInputBatcher,
} from '../../src/tui/workflow/workflowOverlay';

function createBatcher(flushIntervalMs = 16) {
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => {
    sent.push(text);
  });
  return { batcher: new TerminalInputBatcher(send, flushIntervalMs), sent, send };
}

describe('TerminalInputBatcher', () => {
  it('coalesces a burst of keystrokes into a single send', async () => {
    vi.useFakeTimers();
    const { batcher, sent, send } = createBatcher();

    // Typed faster than one frame, which is the normal case for a real typist.
    for (const char of 'hello') batcher.write(char);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);

    // One round trip, not five. At ~18ms per send that is the whole design.
    expect(send).toHaveBeenCalledOnce();
    expect(sent).toEqual(['hello']);
    vi.useRealTimers();
  });

  it('starts a new batch after the previous one flushes', async () => {
    vi.useFakeTimers();
    const { batcher, sent } = createBatcher();

    batcher.write('a');
    await vi.advanceTimersByTimeAsync(20);
    batcher.write('b');
    await vi.advanceTimersByTimeAsync(20);

    expect(sent).toEqual(['a', 'b']);
    vi.useRealTimers();
  });

  it('forwards escape sequences intact rather than per byte', async () => {
    vi.useFakeTimers();
    const { batcher, sent } = createBatcher();

    // An arrow key arrives as one multi-byte sequence; splitting it would send
    // a literal bracket and a letter to the run.
    batcher.write('\x1b[A');
    await vi.advanceTimersByTimeAsync(20);

    expect(sent).toEqual(['\x1b[A']);
    vi.useRealTimers();
  });

  it('ignores empty writes without scheduling a flush', async () => {
    vi.useFakeTimers();
    const { batcher, send } = createBatcher();

    batcher.write('');
    await vi.advanceTimersByTimeAsync(50);

    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // A failed send is a dropped keystroke; an exception would tear down the overlay.
  it('never throws when the send fails', async () => {
    const batcher = new TerminalInputBatcher(async () => {
      throw new Error('cmux exited 1');
    }, 1);

    batcher.write('x');
    await expect(batcher.flush()).resolves.toBeUndefined();
  });

  it('stops forwarding once disposed', async () => {
    vi.useFakeTimers();
    const { batcher, send } = createBatcher();

    batcher.write('typed');
    batcher.dispose();
    await vi.advanceTimersByTimeAsync(50);

    // Nothing may reach a run the user has stopped watching.
    expect(send).not.toHaveBeenCalled();
    expect(batcher.hasPending()).toBe(false);
    vi.useRealTimers();
  });
});

describe('DoubleEscapeDetector', () => {
  const ESC = '\x1b';

  // The whole point of forwarding the first one: a single Escape is how the
  // user interrupts the agent running inside the step.
  it('forwards a lone escape to the run', () => {
    expect(new DoubleEscapeDetector().observe(ESC, 0)).toBe('forward');
  });

  it('closes on a second escape inside the window', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe(ESC, 0)).toBe('forward');
    expect(detector.observe(ESC, 300)).toBe('close');
  });

  // Without the reset, a third escape would close a panel the user has already
  // left, or close the next one they open.
  it('starts over once a pair has fired', () => {
    const detector = new DoubleEscapeDetector();

    detector.observe(ESC, 0);
    detector.observe(ESC, 300);

    expect(detector.observe(ESC, 310)).toBe('forward');
  });

  it('forwards both when they are too far apart to be one gesture', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe(ESC, 0)).toBe('forward');
    expect(detector.observe(ESC, DOUBLE_ESCAPE_WINDOW_MS + 50)).toBe('forward');
  });

  it('treats the window as inclusive at its edge', () => {
    const detector = new DoubleEscapeDetector();

    detector.observe(ESC, 0);

    expect(detector.observe(ESC, DOUBLE_ESCAPE_WINDOW_MS)).toBe('close');
  });

  // Two escapes with typing in between are two interrupts, not a request to
  // leave, and closing the panel there would lose the user's place.
  it('breaks the pair when another key lands in between', () => {
    const detector = new DoubleEscapeDetector();

    detector.observe(ESC, 0);
    expect(detector.observe('a', 50)).toBe('forward');
    expect(detector.observe(ESC, 100)).toBe('forward');
  });

  // Arrow keys and alt-chords start with the escape byte. Reading them as
  // escapes would close the panel on someone scrolling the run's output.
  it('never mistakes an escape sequence for the escape key', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe('\x1b[A', 0)).toBe('forward');
    expect(detector.observe('\x1b[A', 10)).toBe('forward');
    expect(detector.observe('\x1bb', 20)).toBe('forward');
    // Still unarmed: none of the above counted as a first escape.
    expect(detector.observe(ESC, 30)).toBe('forward');
  });

  // The two panel chords are escape-prefixed in legacy mode too, and they are
  // handled before the detector ever sees them.
  it('does not arm on the ctrl+alt chords', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe('\x1b\x17', 0)).toBe('forward');
    expect(detector.observe(ESC, 10)).toBe('forward');
  });

  // One read carrying both bytes is the same gesture as two reads.
  it('closes when both escapes arrive in one chunk', () => {
    expect(new DoubleEscapeDetector().observe('\x1b\x1b', 0)).toBe('close');
  });

  it('closes on a pair of kitty-encoded escapes', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe('\x1b[27u', 0)).toBe('forward');
    expect(detector.observe('\x1b[27u', 100)).toBe('close');
  });

  // Under Kitty flag 2 every press is followed by a release carrying the same
  // codepoint. Counting it would close the panel on a single press.
  it('ignores kitty release events', () => {
    const detector = new DoubleEscapeDetector();

    expect(detector.observe('\x1b[27u', 0)).toBe('forward');
    expect(detector.observe('\x1b[27;1:3u', 10)).toBe('forward');
    // The release neither closed the panel nor disarmed the press before it.
    expect(detector.observe('\x1b[27u', 100)).toBe('close');
  });

  it('honours a custom window', () => {
    const detector = new DoubleEscapeDetector(50);

    detector.observe(ESC, 0);

    expect(detector.observe(ESC, 80)).toBe('forward');
  });
});
