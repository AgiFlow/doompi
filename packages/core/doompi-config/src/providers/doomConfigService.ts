import { type Context, Service } from '@deepseek-ai/cordis';
import {
  DOOM_CONFIG_SERVICE,
  type DeepReadonly,
  type DoomConfig,
  type DoomConfigContext,
  type DoomConfigLoader,
  type IDoomConfigService,
} from '../types/config';

function deepFreeze<TValue>(value: TValue): DeepReadonly<TValue> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<TValue>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<TValue>;
}

/**
 * Doom configuration published on the shared cordis Context.
 *
 * Every extension resolves the same instance by name, so configuration stays
 * one read per session instead of one per consumer, and the registration is
 * removed with the fiber that created it. The loader is injected so this stays
 * free of filesystem access.
 */
export class DoomConfigService extends Service implements IDoomConfigService {
  readonly generation: string;
  private snapshot: DoomConfigContext;

  constructor(
    ctx: Context,
    snapshot: DoomConfigContext,
    private readonly loadConfig: DoomConfigLoader,
    generation = `doom-config:${crypto.randomUUID()}`,
  ) {
    super(ctx, DOOM_CONFIG_SERVICE);
    this.snapshot = deepFreeze(snapshot) as DoomConfigContext;
    this.generation = generation;
  }

  getSnapshot(): DoomConfigContext {
    return this.snapshot;
  }

  replaceSnapshot(context: DoomConfigContext): DoomConfigContext {
    this.snapshot = deepFreeze(context) as DoomConfigContext;
    return this.snapshot;
  }

  load(repoRoot: string, homeDirectory?: string): DoomConfig {
    return this.loadConfig(repoRoot, homeDirectory);
  }
}
