import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  canonicalContractJson,
  DOOM_API_CONTRACT_FILE,
  parseApiContract,
  type DoomCompiledContracts,
  type DoomPackageContract,
} from '@agimon-ai/doompi-core/api-contracts';
import type { DoomServerBundle } from '@agimon-ai/doompi-core/server-facet';

import { compileExtensionModule, extensionModuleManifestPath } from '../../compiler';

const execute = promisify(execFile);
export const CONTRACT_MANIFEST_SUFFIX = '#contracts';

/** Contracts have a separate entry graph so exporting never imports a server facet. */
export async function compileApiContracts(input: {
  descriptor: DoomServerBundle;
  packageRoots: ReadonlyMap<string, string>;
  repositoryRoot: string;
  outputDirectory: string;
  cacheDirectory: string;
  sharedCacheDirectory?: string;
}): Promise<{
  contracts: { file: string; sha256: string };
  compilerManifests: Record<string, string>;
  gaps: string[];
}> {
  fs.mkdirSync(input.outputDirectory, { recursive: true });
  const compiled: DoomCompiledContracts = {
    version: 1,
    generation: input.descriptor.generation,
    fingerprint: input.descriptor.fingerprint,
    packages: [],
  };
  const compilerManifests: Record<string, string> = {};
  const gaps: string[] = [];
  for (const [index, facet] of input.descriptor.entries.entries()) {
    const root = input.packageRoots.get(facet.packageName)!;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: string;
      doompiServer?: { contracts?: { entry?: string; dist?: string } };
    };
    const entry: DoomPackageContract = {
      packageName: facet.packageName,
      packageVersion: manifest.version ?? 'unknown',
      scopes: facet.scopes,
      owners: facet.owners,
    };
    compiled.packages.push(entry);
    try {
      const declaration = manifest.doompiServer?.contracts;
      if (!declaration) throw new Error('No doompiServer.contracts declaration');
      for (const value of [declaration.entry, declaration.dist]) {
        if (typeof value !== 'string' || !value.startsWith('./') || value.includes('..') || /[\\%?#]/u.test(value))
          throw new Error('Contract entry and dist must be contained package-relative files');
        if (value === declaration.dist) {
          const relative = path.relative(fs.realpathSync(root), fs.realpathSync(path.join(root, value)));
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Contract entry escapes package');
        }
      }
      const built = path.resolve(root, declaration.dist!);
      const options = {
        repositoryRoot: input.repositoryRoot,
        sharedCacheDirectory: input.sharedCacheDirectory,
        outputDirectory: path.join(input.outputDirectory, 'contracts', String(index)),
        outputName: 'contract',
      };
      const module = await compileExtensionModule(built, input.cacheDirectory, options);
      compilerManifests[`${facet.packageName}${CONTRACT_MANIFEST_SUFFIX}`] = extensionModuleManifestPath(
        built,
        input.cacheDirectory,
        options,
      );
      entry.module = `./${path.relative(input.outputDirectory, module).split(path.sep).join('/')}`;
      // A bounded separate process keeps module caches, timers and errors out of sync.
      const { stdout } = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'try { const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.default, (_key, value) => { if (typeof value === "function" || typeof value === "bigint" || typeof value === "undefined" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Contract contains non-JSON data"); return value; })); } catch (error) { process.stderr.write(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); process.exitCode = 1; }',
          pathToFileURL(module).href,
        ],
        { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
      entry.contract = parseApiContract(JSON.parse(stdout));
    } catch (error) {
      entry.problem = (
        error !== null &&
        typeof error === 'object' &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.trim()
          ? error.stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error)
      ).slice(0, 1000);
      gaps.push(`${facet.packageName}: ${entry.problem}`);
    }
  }
  const bytes = canonicalContractJson(compiled);
  fs.writeFileSync(path.join(input.outputDirectory, DOOM_API_CONTRACT_FILE), bytes);
  return {
    contracts: { file: `./${DOOM_API_CONTRACT_FILE}`, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    compilerManifests,
    gaps,
  };
}
