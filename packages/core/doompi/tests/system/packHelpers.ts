import {
  type ChildProcessWithoutNullStreams,
  execFile as execFileCallback,
  execFileSync,
  spawn,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RmuxBackend } from '@agimon-ai/doompi-runner/services/RmuxBackend';
import type { IRunnerPaths } from '@agimon-ai/doompi-runner/services/RunnerPaths';
import {
  FORBIDDEN_PACK_CONTENT,
  PACKAGE_MATRIX,
  type PackageMatrixEntry,
  packageRootFor,
  REPOSITORY_ROOT,
} from './packageMatrix.ts';

const PACKAGE_DIRECTORY_NAME = 'package';
const PACK_FILE_SUFFIX = '.tgz';
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const PNPM_COMMAND = 'pnpm';
const PACKAGE_JSON_FILE = 'package.json';
const NON_SOURCE_FILE_SUFFIXES = ['.map', '.d.mts', '.d.cts'] as const;
const UTF8_ENCODING = 'utf8';
const NEWLINE = '\n';
const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';
const INSTALL_BUILD_DEPENDENCIES = ['better-sqlite3', 'protobufjs'] as const;
const PUBLIC_HOST_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@earendil-works/pi-agent-core': '0.84.4',
  '@earendil-works/pi-ai': '0.84.4',
  '@earendil-works/pi-coding-agent': '0.84.4',
  '@earendil-works/pi-tui': '0.84.4',
  '@agimon-ai/vibe-lint': '0.0.1-alpha.26',
};
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 10_000;
const RUNTIME_RECORD_TIMEOUT_MS = 20_000;
const PROCESS_POLL_INTERVAL_MS = 25;
const PTY_COLS = 120;
const PTY_ROWS = 40;
function isNonSourceFile(file: string): boolean {
  return NON_SOURCE_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly keywords?: readonly string[];
  readonly exports?: unknown;
  readonly pi?: { readonly extensions?: readonly string[] };
  readonly bin?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly [key: string]: unknown;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PackedPackage {
  readonly entry: PackageMatrixEntry;
  readonly sourceManifest: PackageManifest;
  readonly tarball: string;
  readonly unpackedRoot: string;
  readonly packedManifest: PackageManifest;
}

export interface ConsumerRoot {
  readonly root: string;
  readonly packageJsonPath: string;
}

export interface RuntimeRecord {
  readonly type?: string;
  readonly id?: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

export interface SpawnedRuntime {
  readonly child: ChildProcessWithoutNullStreams;
  readonly records: RuntimeRecord[];
  readonly stderr: string[];
  readonly nonJsonOutput: string[];
  send(record: Readonly<Record<string, unknown>>): void;
  waitForRecord(predicate: (record: RuntimeRecord) => boolean, timeoutMs?: number): Promise<RuntimeRecord>;
}

export interface SpawnedPtyRuntime {
  readonly pid: number;
  output(): string;
  write(data: string): void;
  waitForExit(timeoutMs?: number): Promise<{ exitCode: number; signal?: number }>;
  stop(signal?: NodeJS.Signals): void;
}

function readJson(file: string): PackageManifest {
  return JSON.parse(fs.readFileSync(file, UTF8_ENCODING)) as PackageManifest;
}

function packageManifestPath(packageRoot: string): string {
  return path.join(packageRoot, PACKAGE_JSON_FILE);
}

function relativePackageFile(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = execFileCallback(
      command,
      [...args],
      {
        cwd,
        env: environment,
        maxBuffer: MAX_COMMAND_OUTPUT,
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr: error ? stderr || error.message : stderr,
        });
      },
    );
    child.stdin?.end();
  });
}

function rewriteWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!dependencies) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => [name, version.startsWith('workspace:') ? '0.0.0' : version]),
  );
}

function createPackStagingRoot(packageRoot: string, packDestination: string, sourceManifest: PackageManifest): string {
  const stagingRoot = path.join(packDestination, 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  for (const relative of sourceManifest.files ?? ['dist']) {
    const source = path.join(packageRoot, relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(stagingRoot, relative), { recursive: true });
  }
  for (const name of fs.readdirSync(packageRoot)) {
    if (!/^(README|LICENSE|CHANGELOG)(\.|$)/i.test(name)) continue;
    fs.cpSync(path.join(packageRoot, name), path.join(stagingRoot, name), { recursive: true });
  }

  const { devDependencies: _devDependencies, ...manifestWithoutDevDependencies } = sourceManifest;
  const stagedManifest: PackageManifest = {
    ...manifestWithoutDevDependencies,
    version: sourceManifest.version ?? '0.0.0',
    dependencies: rewriteWorkspaceDependencies(sourceManifest.dependencies),
    optionalDependencies: rewriteWorkspaceDependencies(sourceManifest.optionalDependencies),
    peerDependencies: rewriteWorkspaceDependencies(sourceManifest.peerDependencies),
  };
  fs.writeFileSync(packageManifestPath(stagingRoot), `${JSON.stringify(stagedManifest, null, 2)}${NEWLINE}`);
  return stagingRoot;
}

async function packPackageFromRoot(
  entry: PackageMatrixEntry,
  outputRoot: string,
  packageRoot: string,
): Promise<PackedPackage> {
  const sourceManifest = readJson(packageManifestPath(packageRoot));
  const packDestination = path.join(outputRoot, entry.name.replaceAll('/', '__').replace(/^@/, ''));
  fs.mkdirSync(packDestination, { recursive: true });
  const stagingRoot = createPackStagingRoot(packageRoot, packDestination, sourceManifest);

  const result = await runCommand(PNPM_COMMAND, ['pack', '--pack-destination', packDestination], stagingRoot);
  if (result.code !== 0) {
    const diagnostics = [result.stderr, result.stdout].filter(Boolean).join(NEWLINE);
    throw new Error(`pnpm pack failed for ${entry.name}: ${diagnostics}`);
  }

  const tarballs = fs.readdirSync(packDestination).filter((file) => file.endsWith(PACK_FILE_SUFFIX));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball for ${entry.name}, found ${tarballs.length}: ${result.stdout}`);
  }
  const tarball = path.join(packDestination, tarballs[0]);
  const unpackedRoot = path.join(packDestination, 'unpacked');
  fs.mkdirSync(unpackedRoot, { recursive: true });
  const unpackResult = await runCommand('tar', ['-xzf', tarball, '-C', unpackedRoot], outputRoot);
  if (unpackResult.code !== 0) {
    throw new Error(`tar extraction failed for ${entry.name}: ${unpackResult.stderr}`);
  }

  const packageDirectory = path.join(unpackedRoot, PACKAGE_DIRECTORY_NAME);
  if (!fs.existsSync(packageDirectory)) throw new Error(`Packed ${entry.name} has no package directory`);
  return {
    entry,
    sourceManifest,
    tarball,
    unpackedRoot: packageDirectory,
    packedManifest: readJson(packageManifestPath(packageDirectory)),
  };
}

export async function packPackage(entry: PackageMatrixEntry, outputRoot: string): Promise<PackedPackage> {
  return packPackageFromRoot(entry, outputRoot, packageRootFor(entry.name));
}

export async function packPackageMatrix(outputRoot: string): Promise<ReadonlyMap<string, PackedPackage>> {
  const packed = new Map<string, PackedPackage>();
  for (const entry of PACKAGE_MATRIX) packed.set(entry.name, await packPackage(entry, outputRoot));
  return packed;
}

export function createTemporaryRoot(prefix: string): string {
  // macOS's per-user tmp path is already long enough that pnpm's encoded store
  // names can cross NAME_MAX during the packed closure install.
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix));
}

export function createConsumerRoot(prefix = 'dp-consumer-'): ConsumerRoot {
  const root = createTemporaryRoot(prefix);
  const packageJsonPath = path.join(root, PACKAGE_JSON_FILE);
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ name: `system-${path.basename(root)}`, private: true, type: 'module', dependencies: {} }, null, 2)}${NEWLINE}`,
  );
  return { root, packageJsonPath };
}

export function writeConsumerDependencies(consumer: ConsumerRoot, dependencies: ReadonlyMap<string, string>): void {
  const manifest = readJson(consumer.packageJsonPath);
  const packageJson = {
    ...manifest,
    dependencies: {
      ...PUBLIC_HOST_DEPENDENCIES,
      ...Object.fromEntries(
        [...dependencies.entries()].map(([name, tarball]) => [name, relativePackageFile(consumer.root, tarball)]),
      ),
    },
  };
  fs.writeFileSync(consumer.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}${NEWLINE}`);
}

export async function installLocalPackages(
  consumer: ConsumerRoot,
  packages: ReadonlyMap<string, PackedPackage>,
): Promise<CommandResult> {
  const tarballs = new Map([...packages.entries()].map(([name, packed]) => [name, packed.tarball]));
  writeConsumerDependencies(consumer, tarballs);
  const workspacePath = path.join(consumer.root, PNPM_WORKSPACE_FILE);
  const overrides = [...tarballs.entries()].map(
    ([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${tarball}`)}`,
  );
  const allowedBuilds = INSTALL_BUILD_DEPENDENCIES.map((name) => `  - ${name}`).join(NEWLINE);
  fs.writeFileSync(
    workspacePath,
    `packages:${NEWLINE}  - '.'${NEWLINE}overrides:${NEWLINE}${overrides.join(NEWLINE)}${NEWLINE}onlyBuiltDependencies:${NEWLINE}${allowedBuilds}${NEWLINE}`,
  );
  try {
    // Reuse pnpm's content-addressed cache; resolution and node_modules remain isolated in the consumer root.
    const install = await runCommand(
      PNPM_COMMAND,
      [
        'install',
        '--lockfile=false',
        '--prefer-offline',
        '--config.auto-install-peers=false',
        '--config.strict-dep-builds=false',
      ],
      consumer.root,
    );
    if (install.code !== 0) return install;
    return runCommand(
      PNPM_COMMAND,
      ['rebuild', ...INSTALL_BUILD_DEPENDENCIES, '--config.strict-dep-builds=false'],
      consumer.root,
    );
  } finally {
    fs.rmSync(workspacePath, { force: true });
  }
}

export function installedPackageRoot(consumerRoot: string, name: string): string {
  return path.join(consumerRoot, 'node_modules', ...name.split('/'));
}

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = resolveExportTarget(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['import', 'default', 'require', 'types']) {
    const resolved = resolveExportTarget(record[key]);
    if (resolved) return resolved;
  }
  for (const candidate of Object.values(record)) {
    const resolved = resolveExportTarget(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

export function exportedFileTargets(manifest: PackageManifest): readonly string[] {
  const targets: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const candidate of value) visit(candidate);
      return;
    }
    if (value && typeof value === 'object') {
      for (const candidate of Object.values(value)) visit(candidate);
    }
  }
  visit(manifest.exports);
  return [...new Set(targets)];
}

export function installedPackageEntry(consumerRoot: string, name: string, subpath: string): string | undefined {
  const packageRoot = installedPackageRoot(consumerRoot, name);
  if (!fs.existsSync(packageRoot)) return undefined;
  const manifest = readJson(packageManifestPath(packageRoot));
  const exportTarget =
    manifest.exports && typeof manifest.exports === 'object'
      ? resolveExportTarget((manifest.exports as Record<string, unknown>)[subpath])
      : undefined;
  const directTarget = exportTarget ?? subpath.replace(/^\.\//, '');
  const target = path.join(packageRoot, directTarget);
  return fs.existsSync(target) ? target : undefined;
}

export function listPackageFiles(root: string): readonly string[] {
  const files: string[] = [];
  function visit(current: string, relative: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Packed output contains a symlink: ${childRelative}`);
      if (entry.isDirectory()) visit(child, childRelative);
      else files.push(childRelative);
    }
  }
  visit(root, '');
  return files.sort();
}

export function filesOutsideAllowlist(manifest: PackageManifest, files: readonly string[]): readonly string[] {
  const allowlist = manifest.files ?? [];
  return files.filter((file) => {
    if (file === PACKAGE_JSON_FILE || /^((README|LICENSE|CHANGELOG)(\.|$))/i.test(file)) return false;
    return !allowlist.some((allowed) => file === allowed || file.startsWith(`${allowed.replace(/\/$/, '')}/`));
  });
}

export function unsafePackedContent(packed: PackedPackage): readonly string[] {
  const issues: string[] = [];
  const files = listPackageFiles(packed.unpackedRoot);
  for (const file of files) {
    if (isNonSourceFile(file)) continue;
    const fullPath = path.join(packed.unpackedRoot, file);
    const content = fs.readFileSync(fullPath, UTF8_ENCODING);
    for (const token of FORBIDDEN_PACK_CONTENT) {
      if (content.includes(token)) issues.push(`${packed.entry.name}:${file}:${token}`);
    }
  }
  return issues;
}

export function writeMinimalDoomRepository(root: string): void {
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doom', 'config.yaml'), 'projectTrust: always\n');
  fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), 'layers: {}\nmajorMode: {}\n');
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function waitForProcessExit(pid: number, timeoutMs = RUNTIME_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
  }
  throw new Error(`Process ${pid} remained alive past its ${timeoutMs}ms shutdown budget`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executableEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function ptyProcessSnapshot(pid: number): string {
  try {
    const processRows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: UTF8_ENCODING });
    const processId = String(pid);
    return (
      processRows
        .split(NEWLINE)
        .filter((row) => row.trim().split(/\s+/, 4).slice(0, 3).includes(processId))
        .join(' | ') || 'not listed'
    );
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

export async function startPtyRuntime(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SpawnedPtyRuntime> {
  const command = [executable, ...args].map(shellQuote).join(' ');
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-packed-rmux-'));
  const logDirectory = path.join(runtimeRoot, 'logs');
  const stateDirectory = path.join(runtimeRoot, 'state');
  const id = `packed-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const name = id;
  const paths: IRunnerPaths = {
    repositoryPath: () => cwd,
    setSessionId: () => undefined,
    logDirectory: () => logDirectory,
    stateDirectory: () => stateDirectory,
    logPathFor: (runnerId) => path.join(logDirectory, `${runnerId}.log`),
    rotatedLogPathFor: (runnerId) => path.join(logDirectory, `${runnerId}.log.1`),
    statePathFor: (runnerId) => path.join(stateDirectory, `${runnerId}.json`),
    ensureDirectories: () => {
      fs.mkdirSync(logDirectory, { recursive: true });
      fs.mkdirSync(stateDirectory, { recursive: true });
    },
    sweepHistory: () => ({ removed: [], errors: [] }),
    legacyDirectory: () => undefined,
    removeLegacyStore: () => undefined,
  };
  const backend = new RmuxBackend(paths);
  const requestedEnvironment = executableEnvironment(environment);
  const previousEnvironment = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, requestedEnvironment);

  let handle: Awaited<ReturnType<RmuxBackend['launch']>>;
  try {
    handle = await backend.launch({ id, name, command, cwd, sessionId: id, interactive: true });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  }
  if (!handle?.pid) throw new Error('RMUX is required for packed runtime PTY tests');
  const pid = handle.pid;
  const ptyRun = backend.get(name);
  if (!ptyRun) throw new Error('RMUX did not expose the packed runtime PTY');
  ptyRun.resize(PTY_COLS, PTY_ROWS);

  let exitResult: { exitCode: number; signal?: number } | undefined;
  const exited = handle.completion().then((result) => {
    const normalized = {
      exitCode: result.code ?? (result.signal ? 1 : 0),
      ...(result.signal ? { signal: 1 } : {}),
    };
    exitResult = normalized;
    return normalized;
  });

  return {
    pid,
    output: () => handle.output() || ptyRun.screen(),
    write: (data) => ptyRun.write(data),
    async waitForExit(timeoutMs = RUNTIME_RECORD_TIMEOUT_MS) {
      if (exitResult) return exitResult;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(`Timed out waiting for PTY process ${pid} to exit; processes: ${ptyProcessSnapshot(pid)}`),
            ),
          timeoutMs,
        );
        void exited.then((result) => {
          clearTimeout(timeout);
          resolve(result);
        });
      });
    },
    stop: () => {
      void handle.stop();
    },
  };
}

export function startRuntime(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): SpawnedRuntime {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const records: RuntimeRecord[] = [];
  const stderr: string[] = [];
  const nonJsonOutput: string[] = [];
  let stdoutBuffer = Buffer.alloc(0);

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const lineFeed = stdoutBuffer.indexOf(0x0a);
      if (lineFeed === -1) break;
      const line = stdoutBuffer.subarray(0, lineFeed).toString(UTF8_ENCODING).replace(/\r$/u, '');
      stdoutBuffer = stdoutBuffer.subarray(lineFeed + 1);
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as RuntimeRecord);
      } catch {
        nonJsonOutput.push(line);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString(UTF8_ENCODING)));

  return {
    child,
    records,
    stderr,
    nonJsonOutput,
    send(record) {
      child.stdin.write(`${JSON.stringify(record)}${NEWLINE}`);
    },
    async waitForRecord(predicate, timeoutMs = RUNTIME_RECORD_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const record = records.find(predicate);
        if (record) return record;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `Runtime exited before the expected RPC record (code ${child.exitCode}, signal ${child.signalCode}): ${stderr.join('')}`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
      }
      throw new Error(`Timed out waiting for an RPC record: ${stderr.join('')}`);
    },
  };
}

export async function shutdownRuntime(runtime: SpawnedRuntime): Promise<void> {
  const pid = runtime.child.pid;
  if (!pid || runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.stdin.end();
  try {
    await waitForProcessExit(pid);
  } catch (shutdownError) {
    if (processExists(pid)) runtime.child.kill('SIGTERM');
    try {
      await waitForProcessExit(pid);
    } catch {
      if (processExists(pid)) runtime.child.kill('SIGKILL');
      await waitForProcessExit(pid).catch((killError: unknown) => {
        throw new Error(`Runtime ${pid} did not stop after stdin close, SIGTERM, and SIGKILL`, {
          cause: killError instanceof Error ? killError : shutdownError,
        });
      });
    }
  }
}

export function installConventionalExtensions(
  consumerRoot: string,
  agentDirectory: string,
  packageNames: readonly string[],
): void {
  const extensionsDirectory = path.join(agentDirectory, 'extensions');
  fs.mkdirSync(extensionsDirectory, { recursive: true });
  for (const name of packageNames) {
    const installedRoot = installedPackageRoot(consumerRoot, name);
    if (!fs.existsSync(installedRoot)) throw new Error(`Cannot discover missing installed package ${name}`);
    const linkName = name.replace(/^@/u, '').replaceAll('/', '__');
    fs.symlinkSync(installedRoot, path.join(extensionsDirectory, linkName), 'dir');
  }
}

export function installedDoomPiCli(consumerRoot: string): string {
  return path.join(installedPackageRoot(consumerRoot, '@agimon-ai/doompi'), 'dist/bin/cli.mjs');
}

export function installedDpiCli(consumerRoot: string): string {
  return path.join(installedPackageRoot(consumerRoot, '@agimon-ai/doompi'), 'dist/bin/dpi.mjs');
}

export function installedPiCli(consumerRoot: string): string {
  return path.join(installedPackageRoot(consumerRoot, '@earendil-works/pi-coding-agent'), 'dist/cli.js');
}

export function packageText(packed: PackedPackage): string {
  return listPackageFiles(packed.unpackedRoot)
    .filter((file) => !isNonSourceFile(file))
    .map((file) => fs.readFileSync(path.join(packed.unpackedRoot, file), UTF8_ENCODING))
    .join('\n');
}

export function packageManifestText(packed: PackedPackage): string {
  return JSON.stringify(packed.packedManifest);
}

export function sourcePackageManifest(name: string): PackageManifest {
  return readJson(path.join(packageRootFor(name), PACKAGE_JSON_FILE));
}

export function packageRootIsInRepository(name: string): boolean {
  return packageRootFor(name).startsWith(REPOSITORY_ROOT);
}
