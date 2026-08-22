/**
 * @agimon-ai/doompi
 *
 * doom-pi is an opinionated, context light, lazy config agent inspired by doom
 * emacs.
 *
 * DESIGN PRINCIPLES:
 * - Barrel exports for a clean API surface
 * - Explicit public API definition
 * - The package default is the stable Pi extension entry. It delegates to the
 *   synced bootstrap recorded in the home-scoped worktree state when one is available.
 */

export { packageBootstrap as default } from '../adapters/packageBootstrap';

// CLI Core - application, argument parsing, and the command framework
export * from './cli';
export * from './commands';

// Configuration - the .doom mode, profile, and theme surfaces
export * from './config';

// Services - matrix resolution and session composition
export * from './services';
// Interfaces - TypeScript contracts and types
export type {
  CompatibilityOptions,
  CompatibilityProvider,
  ParsedCompatibilityArgs,
} from '../types/interfaces/compatibility';
export type {
  HarnessOptions,
  HarnessOutputFormat,
  HarnessPreset,
  ParsedHarnessArgs,
} from '../types/interfaces/harness';
export type { PluginHookSource } from '@agimon-ai/doompi-config/types';
export type { HarnessResourceOptions, HarnessResources } from '@agimon-ai/doompi-domain/resources';
// Utilities - module and repository resolution
export * from './utils';
