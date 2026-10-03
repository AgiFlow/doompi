import type { HookModule } from '../../types/hookModule';

/** Preserve the author's inferred module type while checking the hook contract. */
export function defineDoomHook<T extends HookModule>(module: T): T {
  return module;
}
