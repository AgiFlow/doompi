import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  autocompactExtension,
  findCheckpointWorkerUrl,
  findInstalledPiModuleUrl,
  installAutocompactRuntime,
} from '../src/adapters/pi/extension.ts';
import { generateCheckpointInWorker } from '../src/adapters/process/checkpointWorker.ts';
import standardPiExtension from '../src/exports/extensions/pi.ts';

const adapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/exports/extensions/pi.ts');

describe('Doom Autocompact Pi adapter boundary', () => {
  it('exposes one thin standard Pi factory over the package-local runtime installer', () => {
    expect(standardPiExtension).toBe(autocompactExtension);
    expect(standardPiExtension).not.toBe(installAutocompactRuntime);

    const source = fs.readFileSync(adapterPath, 'utf8');
    expect(source).toContain('autocompactExtension as default');
    expect(source).not.toMatch(/session_start|session_shutdown|registerDoom/u);
  });

  it('finds the private worker by walking upward from the importing file', () => {
    const packageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-autocompact-'));
    const workerPath = path.join(packageDirectory, 'checkpointWorker.mjs');
    const importFilePath = path.join(packageDirectory, 'adapters/pi/extension.mjs');

    try {
      fs.mkdirSync(path.dirname(importFilePath), { recursive: true });
      fs.writeFileSync(workerPath, '');

      expect(fileURLToPath(findCheckpointWorkerUrl(pathToFileURL(importFilePath)))).toBe(workerPath);
    } finally {
      fs.rmSync(packageDirectory, { recursive: true, force: true });
    }
  });

  it('resolves the Pi module from the real target of a symlinked host executable', () => {
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-autocompact-host-'));
    const packageRoot = path.join(hostDirectory, 'lib/node_modules/@earendil-works/pi-coding-agent');
    const cliPath = path.join(packageRoot, 'dist/cli.js');
    const modulePath = path.join(packageRoot, 'dist/index.js');
    const executablePath = path.join(hostDirectory, 'bin/pi');

    try {
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: './dist/index.js' }),
      );
      fs.writeFileSync(cliPath, '');
      fs.writeFileSync(modulePath, '');
      fs.symlinkSync(path.relative(path.dirname(executablePath), cliPath), executablePath);

      expect(fileURLToPath(findInstalledPiModuleUrl([executablePath]))).toBe(fs.realpathSync(modulePath));
    } finally {
      fs.rmSync(hostDirectory, { recursive: true, force: true });
    }
  });

  it('loads the parent-resolved Pi module instead of resolving a worker-local peer', async () => {
    const piModuleUrl = `data:text/javascript,${encodeURIComponent(
      'export async function generateSummary(...args) { return `${args[6]}:${args[7]}`; }',
    )}`;
    const input = {
      piModuleUrl,
      messages: [],
      model: {},
      reserveTokens: 1_024,
      instructions: 'checkpoint instructions',
      previousCheckpoint: 'previous checkpoint',
    } as unknown as Parameters<typeof generateCheckpointInWorker>[0];

    await expect(generateCheckpointInWorker(input)).resolves.toBe('checkpoint instructions:previous checkpoint');
  });
});
