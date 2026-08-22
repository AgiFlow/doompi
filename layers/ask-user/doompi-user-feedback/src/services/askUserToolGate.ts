import type { ActiveToolRegistry } from '../types/toolActivation.js';

/**
 * Drops one tool from Pi's active list while autonomous Voice is speaking.
 *
 * Voice narrates its own question and then waits for the spoken reply, so a questionnaire
 * tool alongside it asks the same thing twice. Ownership is tracked rather than recomputed
 * because the active list is global: the gate restores only a removal it made itself, so a
 * tool the user switched off stays off, and no other package's tools are touched.
 */
export class AskUserToolGate {
  private removed = false;

  constructor(
    private readonly registry: ActiveToolRegistry,
    private readonly toolName: string,
  ) {}

  /** Applies the tool state matching the current autonomous-voice activation. */
  sync(voiceActive: boolean): void {
    if (voiceActive) this.hide();
    else this.release();
  }

  /**
   * Restores a gate-owned removal when the voice binding or the runtime goes away.
   *
   * Safe before the session runtime is bound: without an owned removal it never reaches
   * the registry, and an owned removal proves a bound runtime already accepted a write.
   */
  release(): void {
    if (!this.removed) return;
    this.removed = false;
    const active = this.registry.getActiveTools();
    if (active.includes(this.toolName)) return;
    this.registry.setActiveTools([...active, this.toolName]);
  }

  private hide(): void {
    const active = this.registry.getActiveTools();
    // Read the list rather than trust the flag: Pi rebuilds the active set on a tool
    // refresh, so a stale flag would leave the tool showing for the rest of the session.
    // Already absent means nothing to claim, and claiming it would re-enable a tool the
    // gate never hid.
    if (!active.includes(this.toolName)) return;
    this.registry.setActiveTools(active.filter((name) => name !== this.toolName));
    this.removed = true;
  }
}
