import type { NarrationPlaybackOutcome } from '../services/narration';
import type { AutoCaptureActivationState, AutoCaptureUi } from '../types';

export type VoiceMode = 'legacy' | 'live';

export interface ModeVoiceController {
  readonly state: AutoCaptureActivationState;
  readonly activationId: number;
  readonly activationError: string | undefined;
  readonly microphoneMuted: boolean;
  activate(ui: AutoCaptureUi): Promise<void>;
  deactivate(ui: AutoCaptureUi): Promise<void>;
  toggle(ui: AutoCaptureUi): Promise<void>;
  shutdown(ui?: AutoCaptureUi): Promise<void>;
  setMicrophoneMuted(muted: boolean): void;
  interruptSpeech?(): void;
  askUserBlocked(blocked: boolean): void;
  narrateAgent(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome>;
  narrateExternal(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome>;
  narrateFallback(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome>;
}

export interface VoiceModeControllerDependencies {
  legacy: ModeVoiceController;
  live: ModeVoiceController;
  getMode(): VoiceMode;
}

/** Keeps one controller selected for the complete lifetime of an activation. */
export class VoiceModeController implements ModeVoiceController {
  private mode: VoiceMode = 'legacy';
  private publicActivationId = 0;

  public constructor(private readonly dependencies: VoiceModeControllerDependencies) {}

  public get selectedMode(): VoiceMode {
    return this.mode;
  }

  public get state(): AutoCaptureActivationState {
    return this.selected.state;
  }

  public get activationId(): number {
    return this.publicActivationId;
  }

  public get activationError(): string | undefined {
    return this.selected.activationError;
  }

  public get microphoneMuted(): boolean {
    return this.selected.microphoneMuted;
  }

  public async activate(ui: AutoCaptureUi): Promise<void> {
    if (this.selected.state !== 'disabled') return;
    this.mode = this.dependencies.getMode();
    this.publicActivationId += 1;
    await this.selected.activate(ui);
  }

  public async deactivate(ui: AutoCaptureUi): Promise<void> {
    await this.selected.deactivate(ui);
  }

  public async toggle(ui: AutoCaptureUi): Promise<void> {
    if (this.selected.state === 'disabled') await this.activate(ui);
    else await this.selected.toggle(ui);
  }

  public async shutdown(ui?: AutoCaptureUi): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.dependencies.legacy.shutdown(ui)),
      Promise.resolve().then(() => this.dependencies.live.shutdown(ui)),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  public setMicrophoneMuted(muted: boolean): void {
    this.selected.setMicrophoneMuted(muted);
  }

  public interruptSpeech(): void {
    this.selected.interruptSpeech?.();
  }

  public askUserBlocked(blocked: boolean): void {
    // Approval state is session-wide, including a live controller not selected yet.
    this.dependencies.legacy.askUserBlocked(blocked);
    this.dependencies.live.askUserBlocked(blocked);
  }

  public narrateAgent(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    return this.selected.narrateAgent(text, signal);
  }

  public narrateExternal(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    return this.selected.narrateExternal(text, signal);
  }

  public narrateFallback(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    return this.selected.narrateFallback(text, signal);
  }

  private get selected(): ModeVoiceController {
    return this.dependencies[this.mode];
  }
}
