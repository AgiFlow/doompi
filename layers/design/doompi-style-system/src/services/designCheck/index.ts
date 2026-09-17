import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extractStoryExports } from '../storyPreview';

const STORY_FILE_PATTERN = /\.stories\.(?:js|jsx|ts|tsx)$/u;
const STORY_EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const SOURCE_FILE_PATTERN = /\.(?:css|less|sass|scss|js|jsx|md|ts|tsx)$/u;
const CODE_FILE_PATTERN = /\.(?:js|jsx|ts|tsx)$/u;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MANAGED_TOKEN_PREFIXES = [
  '--doom-',
  '--ds-',
  '--color-',
  '--spacing-',
  '--font-',
  '--radius-',
  '--shadow-',
];
const DEFAULT_COLOR_NAMES =
  'red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone'.split(
    ' ',
  );

export interface DesignTargetManifest {
  version: 1;
  appPath: string;
  storyPath: string;
  storyExport: string;
  sourceRoots?: readonly string[];
  styleFiles?: readonly string[];
  principleDocuments?: readonly string[];
  managedTokens?: readonly string[];
  managedTokenPrefixes?: readonly string[];
}

export interface DesignFinding {
  kind: 'policy-violation' | 'unsupported-token' | 'unresolved';
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  value?: string;
}

export interface DesignFingerprint {
  path: string;
  sha256: string;
  bytes: number;
}

export interface DesignCheckReport {
  version: 1;
  status: 'ready' | 'not-ready' | 'incomplete';
  target: DesignTargetManifest;
  fingerprints: readonly DesignFingerprint[];
  violations: readonly DesignFinding[];
  recognized: readonly { value: string; filePath: string; line: number }[];
  unresolved: readonly DesignFinding[];
  coverage: {
    filesChecked: number;
    bytesChecked: number;
    limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
    classValidation: 'static-extraction-only';
    tokenValidation: 'declared-contract' | 'prefixes-only' | 'not-configured';
  };
}

export interface DesignVerificationResult {
  current: boolean;
  stalePaths: readonly string[];
  report: DesignCheckReport;
}

interface ReadFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  bytes: number;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

async function canonicalPath(root: string, input: string, field: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') throw new Error(`${field} is required`);
  const candidate = path.resolve(root, input);
  const canonical = await fs.promises.realpath(candidate);
  if (!isContained(root, canonical)) throw new Error(`${field} must remain inside the workspace root`);
  return canonical;
}

async function collectFiles(
  root: string,
  inputPath: string,
  files: ReadFile[],
  counters: { bytes: number },
): Promise<void> {
  if (files.length >= MAX_FILES) throw new Error('The design check reached its file limit. Narrow sourceRoots.');
  const stat = await fs.promises.lstat(inputPath);
  if (stat.isSymbolicLink()) throw new Error(`Symlinked design input is not allowed: ${relativePath(root, inputPath)}`);
  if (stat.isDirectory()) {
    const entries = (await fs.promises.readdir(inputPath, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.tmp')
        continue;
      await collectFiles(root, path.join(inputPath, entry.name), files, counters);
    }
    return;
  }
  if (!stat.isFile() || !SOURCE_FILE_PATTERN.test(inputPath)) return;
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Design input is too large: ${relativePath(root, inputPath)}`);
  counters.bytes += stat.size;
  if (counters.bytes > MAX_TOTAL_BYTES) throw new Error('The design check reached its byte limit. Narrow sourceRoots.');
  const content = await fs.promises.readFile(inputPath, 'utf8');
  files.push({ absolutePath: inputPath, relativePath: relativePath(root, inputPath), content, bytes: stat.size });
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function addFinding(findings: DesignFinding[], finding: DesignFinding): void {
  if (
    findings.some(
      (existing) =>
        existing.kind === finding.kind &&
        existing.code === finding.code &&
        existing.filePath === finding.filePath &&
        existing.line === finding.line &&
        existing.value === finding.value,
    )
  )
    return;
  findings.push(finding);
}

function extractClassValues(source: string): Array<{ value: string; index: number; dynamic: boolean }> {
  const values: Array<{ value: string; index: number; dynamic: boolean }> = [];
  const attribute = /\bclassName\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*([`'"])([\s\S]*?)\3\s*\})/gu;
  for (const match of source.matchAll(attribute)) {
    const value = match[1] ?? match[2] ?? match[4] ?? '';
    values.push({ value, index: match.index ?? 0, dynamic: (match[4] ?? '').includes('${') });
  }
  const dynamicAttribute = /\bclassName\s*=\s*\{([\s\S]*?)\}/gu;
  for (const match of source.matchAll(dynamicAttribute)) {
    const body = match[1]?.trim() ?? '';
    if (body !== '' && !/^(['"`])[\s\S]*\1$/u.test(body)) {
      values.push({ value: body, index: match.index ?? 0, dynamic: true });
    }
  }
  const helper = /\b(?:cn|clsx|cva|tv)\s*\(([\s\S]*?)\)/gu;
  for (const match of source.matchAll(helper)) {
    const body = match[1] ?? '';
    const start = (match.index ?? 0) + match[0].indexOf(body);
    const stringless = body.replace(/'[^'\n]*'|"[^"\n]*"/gu, '').replace(/[\s,]/gu, '');
    if (body.includes('${') || stringless !== '') values.push({ value: body, index: start, dynamic: true });
    const literal = /(['"])([^'"\n]*)\1/gu;
    for (const part of body.matchAll(literal))
      values.push({ value: part[2] ?? '', index: start + (part.index ?? 0), dynamic: false });
  }
  return values;
}

function isMarker(value: string): boolean {
  return /^(?:group|peer|dark|light|container|prose)(?:[-:/].*)?$/u.test(value);
}

function policyViolation(value: string): string | undefined {
  const base = value.split('/')[0] ?? value;
  const colorPattern = new RegExp(
    `^(?:bg|text|border|from|to|via|ring|decoration|divide|outline|shadow)-(?:${DEFAULT_COLOR_NAMES.join('|')})-(?:50|[1-9]00)$`,
    'u',
  );
  if (colorPattern.test(base)) return 'raw-theme-color';
  if (/^(?:text|rounded|tracking|leading)-\[[^\]]+\]$/u.test(value)) return 'arbitrary-style-value';
  if (/^(?:bg|text|border|from|to|via|ring)-\[(?:#|rgb|hsl)/u.test(value)) return 'raw-theme-color';
  return undefined;
}

function tokenReferences(source: string): Array<{ name: string; index: number }> {
  return [...source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/gu)].map((match) => ({
    name: match[1]!,
    index: match.index ?? 0,
  }));
}

function declaredTokens(files: readonly ReadFile[]): Set<string> {
  const result = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(/(--[A-Za-z0-9_-]+)\s*:/gu)) result.add(match[1]!);
  }
  return result;
}

function stripComments(source: string): string {
  let output = '';
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== undefined) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
    } else if (character === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < source.length) output += '\n';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index - 1] === '*' && source[index] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
    } else output += character;
  }
  return output;
}

function remoteSpecifier(specifier: string): boolean {
  return /^(?:https?:|data:|file:|\/\/)/iu.test(specifier);
}

async function importExists(
  root: string,
  file: ReadFile,
  specifier: string,
  unresolved: DesignFinding[],
  violations: DesignFinding[],
  index: number,
): Promise<void> {
  if (remoteSpecifier(specifier)) {
    addFinding(violations, {
      kind: 'policy-violation',
      code: 'remote-import',
      message: 'Remote and non-workspace imports are not allowed during a read-only design check.',
      filePath: file.relativePath,
      line: lineAt(file.content, index),
      value: specifier,
    });
    return;
  }
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return;
  if (path.isAbsolute(specifier)) {
    addFinding(violations, {
      kind: 'policy-violation',
      code: 'absolute-import',
      message: 'Absolute imports are not admitted by the workspace design check.',
      filePath: file.relativePath,
      line: lineAt(file.content, index),
      value: specifier,
    });
    return;
  }
  const cleanSpecifier = specifier.split(/[?#]/u)[0]!;
  const candidate = path.resolve(path.dirname(file.absolutePath), cleanSpecifier);
  if (!isContained(root, candidate)) {
    addFinding(violations, {
      kind: 'policy-violation',
      code: 'import-traversal',
      message: 'A relative import escapes the admitted workspace.',
      filePath: file.relativePath,
      line: lineAt(file.content, index),
      value: specifier,
    });
    return;
  }
  const candidates = [
    candidate,
    ...['.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less'].map((extension) => `${candidate}${extension}`),
    ...['index.js', 'index.jsx', 'index.ts', 'index.tsx', 'index.css'].map((name) => path.join(candidate, name)),
  ];
  for (const possible of candidates) {
    try {
      const canonical = await fs.promises.realpath(possible);
      if (!isContained(root, canonical)) {
        addFinding(violations, {
          kind: 'policy-violation',
          code: 'import-symlink-escape',
          message: 'A relative import resolves through a symlink outside the admitted workspace.',
          filePath: file.relativePath,
          line: lineAt(file.content, index),
          value: specifier,
        });
        return;
      }
      const stat = await fs.promises.stat(canonical);
      if (stat.isFile()) return;
    } catch {
      // Try the next conventional extension or index entry.
    }
  }
  addFinding(unresolved, {
    kind: 'unresolved',
    code: 'missing-import',
    message: 'A relative import could not be resolved within the admitted workspace.',
    filePath: file.relativePath,
    line: lineAt(file.content, index),
    value: specifier,
  });
}

async function inspectSource(
  root: string,
  file: ReadFile,
  unresolved: DesignFinding[],
  violations: DesignFinding[],
): Promise<void> {
  const source = stripComments(file.content);
  if (/\.(?:css|less|sass|scss)$/u.test(file.relativePath)) {
    const directives = /@(plugin|config)\b/gu;
    for (const match of source.matchAll(directives)) {
      addFinding(violations, {
        kind: 'policy-violation',
        code: 'executable-style-directive',
        message: `The @${match[1]} directive is executable configuration and is not run by a read-only check.`,
        filePath: file.relativePath,
        line: lineAt(file.content, match.index ?? 0),
        value: `@${match[1]}`,
      });
    }
    const cssImports = /@(?:import|use|forward)\s+(?:url\(\s*)?['"]?([^'")\s]+)['"]?\s*\)?/gu;
    for (const match of source.matchAll(cssImports)) {
      await importExists(root, file, match[1]!, unresolved, violations, match.index ?? 0);
    }
  }
  if (!CODE_FILE_PATTERN.test(file.relativePath)) return;
  const patterns = [
    /\bimport\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gu,
    /\bexport\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gu,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      await importExists(root, file, match[1]!, unresolved, violations, match.index ?? 0);
    }
  }
}
function parseTarget(value: unknown): DesignTargetManifest {
  if (typeof value !== 'object' || value === null) throw new Error('The design target must be a JSON object.');
  const candidate = value as Record<string, unknown>;
  const stringField = (name: string): string => {
    const field = candidate[name];
    if (typeof field !== 'string' || field.trim() === '')
      throw new Error(`The design target field '${name}' is required.`);
    return field;
  };
  const stringList = (name: string): readonly string[] | undefined => {
    const field = candidate[name];
    if (field === undefined) return undefined;
    if (!Array.isArray(field) || field.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`The design target field '${name}' must be a list of non-empty strings.`);
    }
    return field;
  };
  if (candidate.version !== 1) throw new Error('The design target version must be 1.');
  const storyExport = stringField('storyExport');
  if (!STORY_EXPORT_PATTERN.test(storyExport))
    throw new Error('The design target storyExport must be an exact JavaScript named export.');
  return {
    version: 1,
    appPath: stringField('appPath'),
    storyPath: stringField('storyPath'),
    storyExport,
    sourceRoots: stringList('sourceRoots'),
    styleFiles: stringList('styleFiles'),
    principleDocuments: stringList('principleDocuments'),
    managedTokens: stringList('managedTokens'),
    managedTokenPrefixes: stringList('managedTokenPrefixes'),
  };
}

export async function readDesignTarget(filePath: string): Promise<DesignTargetManifest> {
  return parseTarget(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
}

export async function checkDesignTarget(
  target: DesignTargetManifest,
  workspaceRoot: string,
): Promise<DesignCheckReport> {
  const root = await fs.promises.realpath(workspaceRoot);
  if (!STORY_EXPORT_PATTERN.test(target.storyExport))
    throw new Error('The design target storyExport must be an exact JavaScript named export.');
  const storyPath = await canonicalPath(root, target.storyPath, 'storyPath');
  if (!STORY_FILE_PATTERN.test(storyPath))
    throw new Error('storyPath must name a .stories.js, .stories.jsx, .stories.ts, or .stories.tsx file');
  const appPath = await canonicalPath(root, target.appPath, 'appPath');
  const inputs = new Map<string, ReadFile>();
  const counters = { bytes: 0 };
  const coverageFindings: DesignFinding[] = [];
  const addInput = async (input: string, field: string): Promise<void> => {
    const candidate = await canonicalPath(root, input, field);
    const files: ReadFile[] = [];
    await collectFiles(root, candidate, files, counters);
    if (files.length === 0) {
      addFinding(coverageFindings, {
        kind: 'unresolved',
        code: 'input-not-covered',
        message: `No supported source files were found for ${field} input '${relativePath(root, candidate)}'.`,
        filePath: relativePath(root, candidate),
      });
    } else if (field === 'sourceRoots' && !files.some((file) => CODE_FILE_PATTERN.test(file.relativePath))) {
      addFinding(coverageFindings, {
        kind: 'unresolved',
        code: 'source-root-no-code',
        message: `The source root '${relativePath(root, candidate)}' contains no statically inspectable component source files.`,
        filePath: relativePath(root, candidate),
      });
    }
    for (const file of files) inputs.set(file.absolutePath, file);
  };
  await addInput(target.storyPath, 'storyPath');
  for (const input of target.sourceRoots ?? []) await addInput(input, 'sourceRoots');
  for (const input of target.styleFiles ?? []) await addInput(input, 'styleFiles');
  for (const input of target.principleDocuments ?? []) await addInput(input, 'principleDocuments');

  const files = [...inputs.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const violations: DesignFinding[] = [];
  const unresolved: DesignFinding[] = [...coverageFindings];
  const recognized: Array<{ value: string; filePath: string; line: number }> = [];
  const story = files.find((file) => file.absolutePath === storyPath);
  if (story === undefined) throw new Error('The story file was not included in the design inputs.');
  if (!extractStoryExports(story.content).some((entry) => entry.exportName === target.storyExport)) {
    addFinding(violations, {
      kind: 'policy-violation',
      code: 'story-export-missing',
      message: `Story export '${target.storyExport}' was not found in ${story.relativePath}.`,
      filePath: story.relativePath,
      value: target.storyExport,
    });
  }

  for (const file of files) await inspectSource(root, file, unresolved, violations);
  if (!files.some((file) => /\.(?:css|less|sass|scss)$/u.test(file.relativePath))) {
    addFinding(unresolved, {
      kind: 'unresolved',
      code: 'style-context-not-declared',
      message: 'No CSS or token stylesheet was included, so style and token coverage is incomplete.',
    });
  }

  for (const file of files) {
    if (!CODE_FILE_PATTERN.test(file.relativePath)) continue;
    for (const classValue of extractClassValues(file.content)) {
      if (classValue.dynamic) {
        addFinding(unresolved, {
          kind: 'unresolved',
          code: 'dynamic-class-expression',
          message: 'The class expression is dynamic and was not evaluated.',
          filePath: file.relativePath,
          line: lineAt(file.content, classValue.index),
          value: classValue.value,
        });
        continue;
      }
      for (const value of classValue.value.split(/\s+/u).filter(Boolean)) {
        recognized.push({ value, filePath: file.relativePath, line: lineAt(file.content, classValue.index) });
        const code = policyViolation(value);
        if (code !== undefined) {
          addFinding(violations, {
            kind: 'policy-violation',
            code,
            message: `${value} is not an approved semantic design token or scale value.`,
            filePath: file.relativePath,
            line: lineAt(file.content, classValue.index),
            value,
          });
        } else if (isMarker(value)) {
          // Marker classes are valid CSS selectors even when they emit no utility rule.
        }
      }
    }
  }

  const cssInputs = files.filter((file) => /\.(?:css|less|sass|scss)$/u.test(file.relativePath));
  const availableTokens = declaredTokens(cssInputs);
  const configuredTokens = target.managedTokens === undefined ? undefined : new Set(target.managedTokens);
  const prefixes = target.managedTokenPrefixes ?? DEFAULT_MANAGED_TOKEN_PREFIXES;
  let tokenValidation: DesignCheckReport['coverage']['tokenValidation'] = 'not-configured';
  for (const file of files) {
    for (const reference of tokenReferences(file.content)) {
      const managed =
        configuredTokens?.has(reference.name) || prefixes.some((prefix) => reference.name.startsWith(prefix));
      if (!managed) continue;
      tokenValidation = configuredTokens === undefined ? 'prefixes-only' : 'declared-contract';
      if (availableTokens.has(reference.name) || configuredTokens?.has(reference.name)) continue;
      if (configuredTokens !== undefined) {
        addFinding(violations, {
          kind: 'unsupported-token',
          code: 'managed-token-missing',
          message: `Managed design token '${reference.name}' is not declared by the admitted CSS inputs.`,
          filePath: file.relativePath,
          line: lineAt(file.content, reference.index),
          value: reference.name,
        });
      } else {
        addFinding(unresolved, {
          kind: 'unresolved',
          code: 'token-contract-missing',
          message: `The managed token '${reference.name}' could not be verified without an explicit token contract.`,
          filePath: file.relativePath,
          line: lineAt(file.content, reference.index),
          value: reference.name,
        });
      }
    }
  }
  if (target.sourceRoots === undefined || target.sourceRoots.length === 0) {
    addFinding(unresolved, {
      kind: 'unresolved',
      code: 'source-roots-not-declared',
      message: 'No component source roots were declared, so the check is story-local.',
    });
  }

  const fingerprints = files.map((file) => ({
    path: file.relativePath,
    sha256: createHash('sha256').update(file.content).digest('hex'),
    bytes: file.bytes,
  }));
  const status = violations.length > 0 ? 'not-ready' : unresolved.length > 0 ? 'incomplete' : 'ready';
  return {
    version: 1,
    status,
    target: { ...target, appPath: relativePath(root, appPath), storyPath: relativePath(root, storyPath) },
    fingerprints,
    violations,
    recognized,
    unresolved,
    coverage: {
      filesChecked: files.length,
      bytesChecked: counters.bytes,
      limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
      classValidation: 'static-extraction-only',
      tokenValidation,
    },
  };
}

export async function verifyDesignReport(reportPath: string, workspaceRoot: string): Promise<DesignVerificationResult> {
  const report = JSON.parse(await fs.promises.readFile(reportPath, 'utf8')) as DesignCheckReport;
  if (report.version !== 1 || !Array.isArray(report.fingerprints) || report.target === undefined) {
    throw new Error('The readiness report is not version 1.');
  }
  const root = await fs.promises.realpath(workspaceRoot);
  const stalePaths: string[] = [];
  for (const fingerprint of report.fingerprints) {
    try {
      const absolute = await canonicalPath(root, fingerprint.path, 'fingerprint path');
      const content = await fs.promises.readFile(absolute);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== fingerprint.sha256) stalePaths.push(fingerprint.path);
    } catch {
      stalePaths.push(fingerprint.path);
    }
  }
  try {
    const fresh = await checkDesignTarget(report.target, root);
    const evidence = (value: DesignCheckReport) =>
      JSON.stringify({
        status: value.status,
        target: value.target,
        fingerprints: value.fingerprints,
        violations: value.violations,
        recognized: value.recognized,
        unresolved: value.unresolved,
        coverage: value.coverage,
      });
    if (evidence(fresh) !== evidence(report)) stalePaths.push('[check]');
  } catch {
    stalePaths.push('[check]');
  }
  return { current: stalePaths.length === 0, stalePaths: [...new Set(stalePaths)], report };
}
