import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_COLLAPSE_KEY = 'ctrl+]';
export const COLLAPSE_KEY_OFF = 'off';

export interface GuidanceConfig {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface UserFeedbackConfig {
  collapseKey?: string;
  guidance?: GuidanceConfig;
}

function legacyConfigPath(environment: NodeJS.ProcessEnv): string {
  const configRoot = environment.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'rpiv-ask-user-question', 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadUserFeedbackConfig(environment: NodeJS.ProcessEnv = process.env): UserFeedbackConfig {
  const filePath = legacyConfigPath(environment);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) return {};
    const rawGuidance = isRecord(parsed.guidance) ? parsed.guidance : undefined;
    const guidance = rawGuidance
      ? {
          ...(typeof rawGuidance.promptSnippet === 'string' ? { promptSnippet: rawGuidance.promptSnippet } : {}),
          ...(Array.isArray(rawGuidance.promptGuidelines) &&
          rawGuidance.promptGuidelines.every((item) => typeof item === 'string')
            ? { promptGuidelines: rawGuidance.promptGuidelines as string[] }
            : {}),
        }
      : undefined;
    return {
      ...(typeof parsed.collapseKey === 'string' ? { collapseKey: parsed.collapseKey } : {}),
      ...(guidance ? { guidance } : {}),
    };
  } catch {
    return {};
  }
}

export function resolveCollapseKey(config: UserFeedbackConfig): string {
  const value = config.collapseKey?.trim().toLowerCase();
  if (!value) return DEFAULT_COLLAPSE_KEY;
  if (value === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
  return /^[a-z0-9_+\-\]{}]+$/u.test(value) ? value : DEFAULT_COLLAPSE_KEY;
}
