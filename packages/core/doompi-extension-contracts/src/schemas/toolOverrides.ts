import type { Context } from '@deepseek-ai/cordis';

/** Runtime-scoped ownership registry for Pi tool replacements. */
export const DOOM_TOOL_OVERRIDES_SERVICE = 'doom/tool-overrides';

export interface DoomToolOverrideClaim {
  readonly source: string;
  /** One atomic set. The claim is denied when any requested tool is already owned. */
  readonly tools: readonly string[];
}

export interface DoomToolOverrideRegistration {
  readonly granted: boolean;
  readonly tools: readonly string[];
  /** Releases a granted claim. Repeated disposal is a no-op. */
  dispose(): void;
}

export interface DoomToolOverridesService {
  readonly generation: string;
  claim(claim: DoomToolOverrideClaim): DoomToolOverrideRegistration;
  owner(tool: string): string | undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/tool-overrides': DoomToolOverridesService;
  }
}

export function readDoomToolOverrides(context: Context): DoomToolOverridesService | undefined {
  return context.get(DOOM_TOOL_OVERRIDES_SERVICE) as DoomToolOverridesService | undefined;
}

export function requireDoomToolOverrides(context: Context): DoomToolOverridesService {
  const service = readDoomToolOverrides(context);
  if (!service) throw new Error('Doom tool overrides are unavailable. Start a Doom runtime first.');
  return service;
}
