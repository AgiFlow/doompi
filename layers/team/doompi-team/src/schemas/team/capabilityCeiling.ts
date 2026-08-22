/**
 * Capability-ceiling values, intersection, and the child-process codec.
 *
 * Live extension contributions enter through Team's `doom/subagent-policy`
 * Cordis service. Only the resolved ceiling crosses a process boundary, through
 * the versioned environment value encoded here.
 */

import { Buffer } from 'node:buffer';
import type { SubagentPolicy } from '@agimon-ai/doompi-extension-contracts/subagent-policy';
import { SUBAGENT_CAPABILITY_CEILING_ENV } from '../../types/environment';

export const SUBAGENT_CAPABILITY_CEILING_VERSION = 2 as const;
export { SUBAGENT_CAPABILITY_CEILING_ENV };

const MAX_TEXT_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_ALLOWED_TOOLS = 256;
const MAX_ALLOWED_EXTERNAL_PROFILES = 32;
const MAX_EXTERNAL_PROFILE_NAME_BYTES = 128;
const EXTERNAL_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.:-]+$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/u;
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/**
 * Ceiling text crosses a process boundary and is rendered in the TUI, so control
 * characters are rejected. Scanning code points avoids a control-character
 * regex, which lints as a hazard even when the escapes are explicit.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= LAST_C0_CONTROL_CODE || code === DELETE_CODE)) return true;
  }
  return false;
}

export type SubagentCapabilityCeiling = {
  allowedTools?: readonly string[];
  requiredTools?: readonly string[];
  allowMcpTools?: boolean;
  allowedExternalProfiles?: readonly string[];
  denyExtensions?: boolean;
};

export interface ResolvedSubagentCapabilityCeiling {
  version: typeof SUBAGENT_CAPABILITY_CEILING_VERSION;
  allowedTools?: string[];
  requiredTools?: string[];
  allowMcpTools?: boolean;
  allowedExternalProfiles: string[];
  denyExtensions: boolean;
  sources: string[];
}

export interface SubagentCapabilityAudit {
  ceiling: ResolvedSubagentCapabilityCeiling;
  requestedTools?: string[];
  effectiveTools: string[];
  removedTools: string[];
  internalTools: string[];
  extensionsDenied: boolean;
  removedExtensionCount: number;
  requestedMcpToolCount: number;
  effectiveMcpTools: string[];
}

interface TypedPolicyRegistration {
  generation: string;
  ceiling: ResolvedSubagentCapabilityCeiling;
}

export class SubagentCapabilityPolicyStore {
  private readonly policies = new Map<string, TypedPolicyRegistration>();

  register(policy: SubagentPolicy, generation: string): void {
    const ceiling = normalizeCeiling({
      ...(policy.allowedTools ? { allowedTools: policy.allowedTools } : {}),
      ...(policy.requiredTools ? { requiredTools: policy.requiredTools } : {}),
      ...(policy.allowMcpTools === true ? { allowMcpTools: true } : {}),
      ...(policy.allowedExternalProfiles ? { allowedExternalProfiles: policy.allowedExternalProfiles } : {}),
      denyExtensions: policy.denyExtensions === true,
    });
    ceiling.sources = [policy.owner];
    this.policies.set(policy.owner, { generation, ceiling });
  }

  update(policy: SubagentPolicy, generation: string): void {
    if (this.policies.get(policy.owner)?.generation !== generation) return;
    this.register(policy, generation);
  }

  remove(owner: string, generation: string): void {
    if (this.policies.get(owner)?.generation === generation) this.policies.delete(owner);
  }

  clear(): void {
    this.policies.clear();
  }

  resolve(inherited?: ResolvedSubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling | undefined {
    return intersectSubagentCapabilityCeilings(inherited, ...[...this.policies.values()].map(({ ceiling }) => ceiling));
  }
}

function validateText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    hasControlCharacter(value) ||
    Buffer.byteLength(value.trim(), 'utf8') > MAX_TEXT_BYTES
  ) {
    throw new Error(
      `Invalid capability ceiling ${field}; expected a non-empty string without control characters (max ${MAX_TEXT_BYTES} UTF-8 bytes).`,
    );
  }
  return value.trim();
}

function normalizeCeiling(ceiling: SubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling {
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) {
    throw new Error('Invalid capability ceiling; expected an object.');
  }
  const hasAllowedTools = Object.hasOwn(ceiling, 'allowedTools');
  const hasRequiredTools = Object.hasOwn(ceiling, 'requiredTools');
  const hasAllowMcpTools = Object.hasOwn(ceiling, 'allowMcpTools');
  const hasAllowedExternalProfiles = Object.hasOwn(ceiling, 'allowedExternalProfiles');
  const hasDenyExtensions = Object.hasOwn(ceiling, 'denyExtensions');
  if (!hasAllowedTools && !hasRequiredTools && !hasAllowMcpTools && !hasAllowedExternalProfiles && !hasDenyExtensions) {
    throw new Error(
      'Invalid capability ceiling; expected allowedTools, requiredTools, allowMcpTools, allowedExternalProfiles, or denyExtensions.',
    );
  }
  if (hasAllowMcpTools && typeof ceiling.allowMcpTools !== 'boolean') {
    throw new Error('Invalid capability ceiling allowMcpTools; expected a boolean.');
  }
  if (hasDenyExtensions && typeof ceiling.denyExtensions !== 'boolean') {
    throw new Error('Invalid capability ceiling denyExtensions; expected a boolean.');
  }
  const normalizeTools = (value: readonly string[] | undefined, field: 'allowedTools' | 'requiredTools') => {
    if (!Array.isArray(value)) throw new Error(`Invalid capability ceiling ${field}; expected an array.`);
    if (value.length > MAX_ALLOWED_TOOLS) {
      throw new Error(`Invalid capability ceiling ${field}; expected at most ${MAX_ALLOWED_TOOLS} names.`);
    }
    return [
      ...new Set(
        value.map((tool) => {
          const name = validateText(tool, `${field} entry`);
          if (!TOOL_NAME_PATTERN.test(name)) {
            throw new Error(`Invalid capability ceiling ${field} entry '${name}'.`);
          }
          if (Buffer.byteLength(name, 'utf8') > MAX_TOOL_NAME_BYTES) {
            throw new Error(
              `Invalid capability ceiling ${field} entry '${name}'; max ${MAX_TOOL_NAME_BYTES} UTF-8 bytes.`,
            );
          }
          return name;
        }),
      ),
    ].sort((left, right) => left.localeCompare(right));
  };
  const allowedTools = hasAllowedTools ? normalizeTools(ceiling.allowedTools, 'allowedTools') : undefined;
  const requiredTools = hasRequiredTools ? normalizeTools(ceiling.requiredTools, 'requiredTools') : undefined;
  let allowedExternalProfiles: string[] = [];
  if (Object.hasOwn(ceiling, 'allowedExternalProfiles')) {
    if (!Array.isArray(ceiling.allowedExternalProfiles)) {
      throw new Error('Invalid capability ceiling allowedExternalProfiles; expected an array.');
    }
    if (ceiling.allowedExternalProfiles.length > MAX_ALLOWED_EXTERNAL_PROFILES) {
      throw new Error(
        `Invalid capability ceiling allowedExternalProfiles; expected at most ${MAX_ALLOWED_EXTERNAL_PROFILES} names.`,
      );
    }
    allowedExternalProfiles = [
      ...new Set(
        ceiling.allowedExternalProfiles.map((profile) => {
          const name = validateText(profile, 'allowedExternalProfiles entry');
          if (
            !EXTERNAL_PROFILE_PATTERN.test(name) ||
            Buffer.byteLength(name, 'utf8') > MAX_EXTERNAL_PROFILE_NAME_BYTES
          ) {
            throw new Error(`Invalid capability ceiling allowedExternalProfiles entry '${name}'.`);
          }
          return name;
        }),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }
  return {
    version: SUBAGENT_CAPABILITY_CEILING_VERSION,
    ...(allowedTools ? { allowedTools } : {}),
    ...(requiredTools?.length ? { requiredTools } : {}),
    ...(ceiling.allowMcpTools === true ? { allowMcpTools: true } : {}),
    allowedExternalProfiles,
    denyExtensions: ceiling.denyExtensions === true,
    sources: [],
  };
}

export function parseSubagentCapabilityCeiling(
  value: unknown,
  field = 'capability ceiling',
): ResolvedSubagentCapabilityCeiling {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${field}; expected an object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SUBAGENT_CAPABILITY_CEILING_VERSION) throw new Error(`Invalid ${field} version.`);
  const normalized = normalizeCeiling(record as SubagentCapabilityCeiling);
  const sources = record.sources;
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'string')) {
    throw new Error(`Invalid ${field} sources; expected an array of strings.`);
  }
  normalized.sources = [...new Set(sources.map((source) => validateText(source, `${field} source`)))].sort();
  return normalized;
}

export function intersectSubagentCapabilityCeilings(
  ...ceilings: Array<ResolvedSubagentCapabilityCeiling | undefined>
): ResolvedSubagentCapabilityCeiling | undefined {
  const active = ceilings.filter((ceiling): ceiling is ResolvedSubagentCapabilityCeiling => ceiling !== undefined);
  if (active.length === 0) return undefined;
  const definedLists = active
    .filter((ceiling) => ceiling.allowedTools !== undefined)
    .map((ceiling) => new Set(ceiling.allowedTools));
  let allowedTools: string[] | undefined;
  if (definedLists.length > 0) {
    allowedTools = [...definedLists[0]!].filter((tool) => definedLists.every((list) => list.has(tool))).sort();
  }
  const requiredTools = [...new Set(active.flatMap((ceiling) => ceiling.requiredTools ?? []))]
    .filter((tool) => !allowedTools || allowedTools.includes(tool))
    .sort((left, right) => left.localeCompare(right));
  const profileSets = active.map((ceiling) => new Set(ceiling.allowedExternalProfiles));
  const allowedExternalProfiles = [...profileSets[0]!]
    .filter((profile) => profileSets.every((profiles) => profiles.has(profile)))
    .sort((left, right) => left.localeCompare(right));
  return {
    version: SUBAGENT_CAPABILITY_CEILING_VERSION,
    ...(allowedTools ? { allowedTools } : {}),
    ...(requiredTools.length ? { requiredTools } : {}),
    ...(active.every((ceiling) => ceiling.allowMcpTools === true) ? { allowMcpTools: true } : {}),
    allowedExternalProfiles,
    denyExtensions: active.some((ceiling) => ceiling.denyExtensions),
    sources: [...new Set(active.flatMap((ceiling) => ceiling.sources))].sort(),
  };
}

export function encodeSubagentCapabilityCeiling(
  ceiling: ResolvedSubagentCapabilityCeiling | undefined,
): string | undefined {
  if (!ceiling) return undefined;
  return Buffer.from(JSON.stringify(ceiling), 'utf8').toString('base64url');
}

export function decodeSubagentCapabilityCeiling(
  value: string | undefined,
): ResolvedSubagentCapabilityCeiling | undefined {
  if (value === undefined || value === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid inherited capability ceiling: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== SUBAGENT_CAPABILITY_CEILING_VERSION
  ) {
    throw new Error('Invalid inherited capability ceiling version.');
  }
  return parseSubagentCapabilityCeiling(parsed, 'inherited capability ceiling');
}
