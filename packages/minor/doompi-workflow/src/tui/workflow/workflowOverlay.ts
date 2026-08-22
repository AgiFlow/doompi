/**
 * Input plumbing for the run panel: keystroke batching and the escape hatch.
 *
 * The panel's rendering lives in `workflowRunPanel.ts`, which is a doom overlay;
 * what stays here is the behaviour that has nothing to do with drawing.
 *
 * DESIGN PATTERNS:
 * - Input batching. Every keystroke sent individually costs one subprocess
 *   round trip, measured at ~18ms, which caps sustained typing near 56 c/s and
 *   makes held keys queue visibly. Coalescing a frame's bytes into one send
 *   keeps latency at roughly one frame no matter how fast the user types.
 * - Stateless render. The component recomputes from the latest snapshot on
 *   every frame, so a theme change needs no cache invalidation.
 * - Terminal-independent escape hatch. The focused panel forwards every key to
 *   the run, so the way out cannot itself depend on a modifier the terminal
 *   may not transmit.
 *
 * CODING STANDARDS:
 * - Named exports only
 * - Explicit return types on exported members
 *
 * AVOID:
 * - Sending per keystroke: it is the difference between usable and unusable
 * - Holding the flush timer open after dispose, which would keep writing into
 *   a run the user has stopped watching
 */

import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';

/** One frame at 60Hz. Long enough to coalesce a burst, short enough to feel direct. */
const FLUSH_INTERVAL_MS = 16;

/**
 * How close two Escapes must be to read as "get me out".
 *
 * Long enough to be reachable without hurrying, short enough that two
 * deliberate, separate interrupts sent to the run are not mistaken for it.
 */
export const DOUBLE_ESCAPE_WINDOW_MS = 350;

/** What the overlay should do with a keystroke. */
export type EscapeAction = 'forward' | 'close';

/**
 * The panel's guaranteed way out: press Escape twice, quickly.
 *
 * A focused panel hands every key to the run so its agent stays interruptible,
 * which leaves the two `ctrl+alt` chords as the only exits. Those are exactly
 * the keys a terminal may not deliver: macOS without Option-as-Meta sends plain
 * `ctrl+w` instead, and the byte is forwarded into the run rather than matching.
 * The user is then inside a view they cannot leave. Escape is the one key every
 * terminal transmits identically, which is what makes it the failsafe.
 *
 * The first Escape is still forwarded, so interrupting the step stays as fast as
 * it ever was. Only the second one is consumed, and only when it lands inside
 * the window. The cost is one keystroke: sending the run two literal Escapes in
 * quick succession is no longer possible, which is worth an escapable panel.
 */
export class DoubleEscapeDetector {
  private lastEscapeAt: number | undefined;

  constructor(private readonly windowMs: number = DOUBLE_ESCAPE_WINDOW_MS) {}

  /**
   * Classify one chunk of terminal input.
   *
   * `now` is injected so the decision is a pure function of its inputs, which
   * is what makes the window testable without timers.
   */
  observe(data: string, now: number = Date.now()): EscapeAction {
    // Two Escapes coalesced into one read. A terminal in legacy mode delivers
    // this when they arrive inside the same poll, so it is the same gesture and
    // has to reach the same answer. `matchesKey` never sees it as an escape:
    // it parses as ctrl+alt+[, which has no meaning to a run either way.
    if (data === '\x1b\x1b') {
      this.lastEscapeAt = undefined;
      return 'close';
    }

    // A Kitty release event repeats the press's own bytes. Counting it would
    // turn one deliberate press into a pair and close the panel under the user.
    if (isKeyRelease(data)) return 'forward';

    if (!matchesKey(data, 'escape')) {
      // Anything typed in between makes these two separate interrupts rather
      // than one gesture, so the pair has to start over.
      this.lastEscapeAt = undefined;
      return 'forward';
    }

    if (this.lastEscapeAt !== undefined && now - this.lastEscapeAt <= this.windowMs) {
      this.lastEscapeAt = undefined;
      return 'close';
    }

    this.lastEscapeAt = now;
    return 'forward';
  }
}

/**
 * Collects keystrokes and forwards them in frame-sized batches.
 *
 * Failures are swallowed on purpose: a dropped keystroke is a nuisance, but an
 * exception raised from a terminal input handler would tear down the overlay.
 */
export class TerminalInputBatcher {
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly flushIntervalMs: number = FLUSH_INTERVAL_MS,
  ) {}

  write(data: string): void {
    if (this.disposed || data.length === 0) return;
    this.pending += data;
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Send whatever has accumulated. Safe to call with nothing pending. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.pending;
    this.pending = '';
    if (!text || this.disposed) return;
    try {
      await this.send(text);
    } catch {
      // A dropped keystroke must not take the overlay down with it.
    }
  }

  /** Stop accepting and forwarding input. Pending bytes are discarded. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
  }

  /** Exposed for tests: whether a flush is scheduled. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
