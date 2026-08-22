import { type Context, Service } from '@deepseek-ai/cordis';
import type { PromptCacheTelemetryPort, PromptCacheTelemetrySnapshot } from '../types/cache.ts';

export const DOOM_PROMPT_CACHE_TELEMETRY_SERVICE = 'doom/prompt-cache-telemetry';

export class PromptCacheTelemetryService extends Service {
  constructor(
    context: Context,
    private readonly telemetry: PromptCacheTelemetryPort,
  ) {
    super(context, DOOM_PROMPT_CACHE_TELEMETRY_SERVICE);
  }

  snapshot(): PromptCacheTelemetrySnapshot {
    return this.telemetry.snapshot();
  }
}

export function readPromptCacheTelemetry(context: Context): PromptCacheTelemetryService | undefined {
  return context.get(DOOM_PROMPT_CACHE_TELEMETRY_SERVICE) as PromptCacheTelemetryService | undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/prompt-cache-telemetry': PromptCacheTelemetryService;
  }
}
