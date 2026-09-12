import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON state helpers for files the harness owns on disk.
 *
 * Compatibility frontends read these files while another repository's harness
 * may be writing them, so writes go through a rename rather than a truncate.
 */

export type JsonObject = Record<string, unknown>;

const ATOMIC_FILE_SUFFIX = '.tmp';

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a JSON object, treating a missing or empty file as the fallback. */
export function readJson(filePath: string, fallback: JsonObject = {}): JsonObject {
  if (!fs.existsSync(filePath)) return fallback;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content ? (JSON.parse(content) as JsonObject) : fallback;
}

/**
 * Writes through a uniquely named temporary file in the same directory.
 *
 * The pid and a UUID are both in the name so two harnesses writing the same
 * target cannot collide on the temporary path, and a failed write cleans up
 * after itself rather than leaving the fragment behind.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}${ATOMIC_FILE_SUFFIX}`;
  try {
    fs.writeFileSync(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function writeJson(filePath: string, value: JsonObject): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
