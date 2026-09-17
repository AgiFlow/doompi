#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkDesignTarget, readDesignTarget, verifyDesignReport } from '../services/designCheck';
import { StoryPreviewService } from '../services/storyPreview';

const DISCOVERY_COMMANDS = new Set([
  'list-shared-components',
  'list-app-components',
  'get-css-classes',
  'list-themes',
  'get-ui-component',
]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 120_000;
const STRUCTURED_COMMANDS = new Set(['metadata', 'story-metadata', 'check', 'verify', 'preview']);

type ParsedArguments = {
  command: string | undefined;
  values: readonly string[];
  workspace: string;
};

function option(values: readonly string[], ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const inline = values.find((value) => value.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = values.indexOf(name);
    const value = index < 0 ? undefined : values[index + 1];
    if (value !== undefined && !value.startsWith('--')) return value;
  }
  return undefined;
}

function requiredOption(values: readonly string[], name: string): string {
  const value = option(values, name);
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...values] = argv;
  return {
    command,
    values,
    workspace: path.resolve(option(values, '--workspace', '--workspace-root') ?? process.cwd()),
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function reportExitCode(status: 'ready' | 'not-ready' | 'incomplete'): number {
  return status === 'ready' ? 0 : status === 'not-ready' ? 1 : 2;
}

function upstreamCliPath(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@agimon-ai/style-system/package.json') as string;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['style-system'];
  if (bin === undefined) throw new Error('The installed style-system package does not expose its CLI.');
  return path.resolve(path.dirname(packageJsonPath), bin);
}

function stripWorkspaceOptions(values: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === '--workspace' || value === '--workspace-root') {
      index += 1;
      continue;
    }
    if (value.startsWith('--workspace=') || value.startsWith('--workspace-root=')) continue;
    result.push(value);
  }
  return result;
}

async function delegateDiscovery(values: readonly string[], workspace: string): Promise<number> {
  const child = spawn(process.execPath, [upstreamCliPath(), ...stripWorkspaceOptions(values)], {
    cwd: workspace,
    env: { ...process.env },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return new Promise<number>((resolve) => {
    let outputBytes = 0;
    let settled = false;
    let exceeded = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(code);
    };
    const forward = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        exceeded = true;
        child.kill('SIGTERM');
        return;
      }
      stream.write(chunk);
    };
    child.once('error', (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      finish(3);
    });
    child.once('exit', (code, signal) => {
      if (exceeded || signal !== null) finish(3);
      else finish(code ?? 3);
    });
    child.stdout.on('data', (chunk: Buffer) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => forward(chunk, process.stderr));
    timeout = setTimeout(() => {
      exceeded = true;
      child.kill('SIGTERM');
    }, DISCOVERY_TIMEOUT_MS);
  }).then((result) => {
    if (result === 3) process.stderr.write('style-system discovery timed out, exceeded its output limit, or failed.\n');
    return result;
  });
}

async function containedPath(root: string, input: string, field: string): Promise<string> {
  const candidate = path.resolve(root, input);
  if (!isContained(root, candidate)) throw new Error(`${field} must remain inside the workspace root`);
  const canonical = await fs.realpath(candidate);
  if (!isContained(root, canonical)) throw new Error(`${field} must remain inside the workspace root`);
  return canonical;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function outputPath(root: string, input: string, field: string): Promise<string> {
  const candidate = path.resolve(root, input);
  if (!isContained(root, candidate)) throw new Error(`${field} must remain inside the workspace root`);
  let existing = candidate;
  while (true) {
    try {
      const canonical = await fs.realpath(existing);
      if (!isContained(root, canonical)) throw new Error(`${field} must remain inside the workspace root`);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`${field} must remain inside the workspace root`);
      existing = parent;
    }
  }
}

async function runStructured(parsed: ParsedArguments, workspace: string): Promise<number> {
  const { command, values } = parsed;
  if (command === 'metadata' || command === 'story-metadata') {
    const service = new StoryPreviewService(workspace);
    printJson(
      await service.metadata({
        storyPath: requiredOption(values, '--story-path'),
        appPath: option(values, '--app-path'),
      }),
    );
    return 0;
  }
  if (command === 'check') {
    const target = await readDesignTarget(await containedPath(workspace, requiredOption(values, '--target'), 'target'));
    const report = await checkDesignTarget(target, workspace);
    const reportFile = option(values, '--report');
    if (reportFile !== undefined) {
      const targetPath = await outputPath(workspace, reportFile, 'report');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    printJson(report);
    return reportExitCode(report.status);
  }
  if (command === 'verify') {
    const result = await verifyDesignReport(
      await containedPath(workspace, requiredOption(values, '--report'), 'report'),
      workspace,
    );
    printJson(result);
    return result.current && result.report.status === 'ready' ? 0 : 2;
  }
  if (command === 'preview') {
    const service = new StoryPreviewService(workspace);
    const result = await service.build({
      appPath: requiredOption(values, '--app-path'),
      storyPath: requiredOption(values, '--story-path'),
      storyExport: requiredOption(values, '--story-export'),
      darkMode: values.includes('--dark-mode'),
    });
    try {
      const output = option(values, '--output');
      if (output === undefined) process.stdout.write(result.html);
      else {
        const targetPath = await outputPath(workspace, output, 'output');
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, result.html, 'utf8');
        printJson({ handle: result.handle, storyPath: result.storyPath, storyExport: result.storyExport, outputPath: path.relative(workspace, targetPath) });
      }
    } finally {
      await service.dispose(result.handle);
    }
    return 0;
  }
  throw new Error(`Unknown structured command '${command ?? ''}'.`);
}

function help(): void {
  process.stdout.write(
    [
      'doompi-design <command>',
      '',
      'Discovery commands delegated to @agimon-ai/style-system:',
      '  list-shared-components, list-app-components, get-css-classes, list-themes, get-ui-component',
      '',
      'Portable commands:',
      '  metadata --story-path <path> [--app-path <path>]',
      '  check --target <path> [--report <path>]',
      '  verify --report <path>',
      '  preview --app-path <path> --story-path <path> --story-export <name> [--output <path>]',
      '',
      'Use --workspace <path> to select the admitted workspace for any command.',
    ].join('\n') + '\n',
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.command === undefined || parsed.command === '--help' || parsed.command === '-h') {
    help();
    return 0;
  }
  const workspace = await fs.realpath(parsed.workspace);
  if (DISCOVERY_COMMANDS.has(parsed.command)) return delegateDiscovery([parsed.command, ...parsed.values], workspace);
  if (!STRUCTURED_COMMANDS.has(parsed.command)) throw new Error(`Unknown command '${parsed.command}'.`);
  return runStructured(parsed, workspace);
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
    },
  );
}
