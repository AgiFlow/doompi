/**
 * Artifact file layout and retention for subagent runs.
 *
 * DESIGN PATTERNS:
 * - Path shape is derived, never stored: `getArtifactPaths` is pure so a reader
 *   can reconstruct every file for a run from the run id and agent name alone
 * - The agent name is sanitised into the filename because it comes from
 *   user-authored frontmatter and would otherwise let a run write outside the
 *   artifacts directory
 * - Cleanup is rate-limited by a marker file rather than by an in-process timer,
 *   so several concurrent extension hosts do not each sweep on every startup
 *
 * AVOID:
 * - Failing a run because housekeeping failed; every cleanup error is swallowed
 *   deliberately and the sweep continues with the next entry
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArtifactDirPreference, ArtifactPaths } from '../../types';
import { writeAtomicJson } from '../atomicJson';
import { getAgentDir } from './configDir';
import { TEMP_ARTIFACTS_DIR } from './paths';

const CLEANUP_MARKER_FILE = '.last-cleanup';
/**
 * In-project artifact root, named for this package rather than its predecessor.
 *
 * Both packages can be installed at once during cutover, and both sweep their
 * root on a retention timer. A shared name would let one package's cleanup delete
 * the other's live artifacts, so the roots are kept disjoint.
 */
const PROJECT_ARTIFACT_ROOT = '.doom-team';
const PROJECT_ARTIFACTS_DIR_NAME = 'artifacts';
const PROJECT_CHAIN_RUNS_DIR_NAME = 'chain-runs';
const SESSION_ARTIFACTS_DIR_NAME = 'subagent-artifacts';
const SESSIONS_DIR_NAME = 'sessions';
const UNSAFE_AGENT_NAME_CHARS = /[^\w.-]/g;
const AGENT_NAME_REPLACEMENT = '_';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = MS_PER_DAY;

export function getProjectSubagentsDir(cwd: string): string {
  return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}

export function getProjectArtifactsDir(cwd: string): string {
  return path.join(getProjectSubagentsDir(cwd), PROJECT_ARTIFACTS_DIR_NAME);
}

export function getProjectChainRunsDir(cwd: string): string {
  return path.join(getProjectSubagentsDir(cwd), PROJECT_CHAIN_RUNS_DIR_NAME);
}

export function getArtifactsDir(
  sessionFile: string | null,
  projectCwd?: string,
  dirPreference: ArtifactDirPreference = 'session',
): string {
  switch (dirPreference) {
    case 'session':
      if (sessionFile) {
        const sessionDir = path.dirname(sessionFile);
        return path.join(sessionDir, SESSION_ARTIFACTS_DIR_NAME);
      }
      return TEMP_ARTIFACTS_DIR;
    case 'temp':
      return TEMP_ARTIFACTS_DIR;
    case 'project':
      if (projectCwd) return getProjectArtifactsDir(projectCwd);
      if (sessionFile) {
        const sessionDir = path.dirname(sessionFile);
        return path.join(sessionDir, SESSION_ARTIFACTS_DIR_NAME);
      }
      return TEMP_ARTIFACTS_DIR;
    default:
      throw new Error(
        `Unsupported artifactDir ${JSON.stringify(dirPreference)}; expected "project", "session", or "temp".`,
      );
  }
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
  const suffix = index !== undefined ? `_${index}` : '';
  const safeAgent = agent.replace(UNSAFE_AGENT_NAME_CHARS, AGENT_NAME_REPLACEMENT);
  const base = `${runId}_${safeAgent}${suffix}`;
  return {
    inputPath: path.join(artifactsDir, `${base}_input.md`),
    outputPath: path.join(artifactsDir, `${base}_output.md`),
    jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
    transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
    metadataPath: path.join(artifactsDir, `${base}_meta.json`),
  };
}

export function ensureArtifactsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function formatOutputArtifactContent(input: {
  output: string;
  error?: string;
  transcriptPath?: string;
  metadataPath?: string;
}): string {
  // An empty output artifact tells the reader nothing about why a run produced
  // nothing, so a failure with no output is replaced by the error and its evidence.
  if (input.output.trim() || !input.error) return input.output;
  const lines = ['Subagent run failed before producing output.', '', 'Error:', input.error];
  if (input.transcriptPath) lines.push('', `Transcript: ${input.transcriptPath}`);
  if (input.metadataPath) lines.push(`Metadata: ${input.metadataPath}`);
  return lines.join('\n');
}

/**
 * Publish a run's metadata sidecar.
 *
 * Written atomically because the parent polls this file while the run is still
 * producing it, and a direct write lets that poll observe a half-serialised object.
 */
export function writeMetadata(filePath: string, metadata: object): void {
  writeAtomicJson(filePath, metadata);
}

export function appendJsonl(filePath: string, line: string): void {
  fs.appendFileSync(filePath, `${line}\n`);
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
  if (!fs.existsSync(dir)) return;

  const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
  const now = Date.now();

  if (fs.existsSync(markerPath)) {
    if (now - fs.statSync(markerPath).mtimeMs < CLEANUP_INTERVAL_MS) return;
  }

  const maxAgeMs = maxAgeDays * MS_PER_DAY;
  const cutoff = now - maxAgeMs;

  for (const file of fs.readdirSync(dir)) {
    if (file === CLEANUP_MARKER_FILE) continue;
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Artifact cleanup is best-effort housekeeping. Skip files that disappear
      // or become unreadable while scanning so one bad entry does not block the rest.
    }
  }

  fs.writeFileSync(markerPath, String(now));
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
  cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

  const sessionsBase = path.join(getAgentDir(), SESSIONS_DIR_NAME);
  if (!fs.existsSync(sessionsBase)) return;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsBase);
  } catch {
    // Session artifact cleanup is best-effort. If the sessions root cannot be read,
    // skip cleanup instead of failing extension startup.
    return;
  }

  for (const dir of dirs) {
    const artifactsDir = path.join(sessionsBase, dir, SESSION_ARTIFACTS_DIR_NAME);
    try {
      cleanupOldArtifacts(artifactsDir, maxAgeDays);
    } catch {
      // Session cleanup is best-effort. Keep going so one unreadable session dir
      // does not block cleanup for the rest.
    }
  }
}
