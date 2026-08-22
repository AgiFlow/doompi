/**
 * Configuration owned by the @agimon-ai/doompi-team package entry in modes.yaml.
 *
 * DESIGN PATTERNS:
 * - Doompi Config validates the generic package-entry envelope; Team validates
 *   only the fields it owns.
 * - Selected layers are merged in order: later model lists replace earlier
 *   lists, while excluded tools are unioned in first-seen order.
 *
 * CODING STANDARDS:
 * - Reject unknown fields and malformed values with their YAML location.
 * - Return normalized copies so callers cannot mutate parsed source objects.
 *
 * AVOID:
 * - Adding Team-specific fields to doompi-config's generic layer schema.
 * - Accepting the removed layer-level config shape as a compatibility alias.
 */

import type { PlanningThinkingLevel, ResolvedPackageConfiguration } from '@agimon-ai/doompi-config';

export const DOOMPI_TEAM_PACKAGE = '@agimon-ai/doompi-team';

const TEAM_CONFIG_KEYS = ['models', 'excludeTools'] as const;
const TEAM_MODEL_KEYS = ['model', 'thinking'] as const;
const THINKING_VALUES = new Set<PlanningThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface TeamPackageModelConfig {
  model: string;
  thinking?: PlanningThinkingLevel;
}

export interface TeamPackageConfig {
  models?: TeamPackageModelConfig[];
  excludeTools?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const unsupported = Object.keys(value).filter((key) => !keys.includes(key));
  if (unsupported.length > 0) {
    throw new Error(`${location} has unsupported field(s): ${unsupported.join(', ')}`);
  }
}

/** Validate and normalize one Team-owned package configuration mapping. */
export function parseTeamPackageConfig(value: unknown, location: string): TeamPackageConfig {
  if (!isRecord(value)) throw new Error(`${location} must be a mapping`);
  assertKnownKeys(value, TEAM_CONFIG_KEYS, location);
  const hasModels = Object.hasOwn(value, 'models');
  const hasExcludeTools = Object.hasOwn(value, 'excludeTools');
  if (!hasModels && !hasExcludeTools) {
    throw new Error(`${location} must define models or excludeTools`);
  }

  let models: TeamPackageModelConfig[] | undefined;
  if (hasModels) {
    if (!Array.isArray(value.models) || value.models.length === 0) {
      throw new Error(`${location}.models must be a non-empty array`);
    }
    models = value.models.map((entry, index): TeamPackageModelConfig => {
      const entryLocation = `${location}.models[${index}]`;
      if (!isRecord(entry)) throw new Error(`${entryLocation} must be a mapping`);
      assertKnownKeys(entry, TEAM_MODEL_KEYS, entryLocation);
      if (typeof entry.model !== 'string' || !entry.model.trim()) {
        throw new Error(`${entryLocation}.model must be a non-empty string`);
      }
      if (
        entry.thinking !== undefined &&
        (typeof entry.thinking !== 'string' || !THINKING_VALUES.has(entry.thinking as PlanningThinkingLevel))
      ) {
        throw new Error(`${entryLocation}.thinking must be one of: ${[...THINKING_VALUES].join(', ')}`);
      }
      return {
        model: entry.model.trim(),
        ...(entry.thinking ? { thinking: entry.thinking as PlanningThinkingLevel } : {}),
      };
    });
  }

  let excludeTools: string[] | undefined;
  if (hasExcludeTools) {
    if (!Array.isArray(value.excludeTools) || value.excludeTools.length === 0) {
      throw new Error(`${location}.excludeTools must be a non-empty array`);
    }
    excludeTools = [
      ...new Set(
        value.excludeTools.map((entry, index) => {
          if (typeof entry !== 'string' || !entry.trim()) {
            throw new Error(`${location}.excludeTools[${index}] must be a non-empty string`);
          }
          return entry.trim();
        }),
      ),
    ];
  }

  return {
    ...(models ? { models } : {}),
    ...(excludeTools ? { excludeTools } : {}),
  };
}

/** Merge Team configurations contributed by selected layers in selection order. */
export function mergeTeamPackageConfigurations(
  entries: readonly ResolvedPackageConfiguration[],
): TeamPackageConfig | undefined {
  let models: TeamPackageModelConfig[] | undefined;
  const excludeTools = new Set<string>();
  let hasExcludeTools = false;
  for (const entry of entries) {
    const location = `Package "${entry.specifier}" config in layer "${entry.layer}" of .doom/modes.yaml`;
    const next = parseTeamPackageConfig(entry.config, location);
    if (next.models) models = next.models.map((model) => ({ ...model }));
    if (next.excludeTools) {
      hasExcludeTools = true;
      for (const tool of next.excludeTools) excludeTools.add(tool);
    }
  }
  if (!models && !hasExcludeTools) return undefined;
  return {
    ...(models ? { models } : {}),
    ...(hasExcludeTools ? { excludeTools: [...excludeTools] } : {}),
  };
}
