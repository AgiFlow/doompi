import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import {
  canonicalContractJson,
  createApiDocuments,
  parseCompiledContracts,
  type ApiContractSelection,
  type ApiDocuments,
} from '@agimon-ai/doompi-core/api-contracts';
import { parseDoomServerBundle } from '@agimon-ai/doompi-core/server-facet';
import { readSyncRegistration } from '@agimon-ai/doompi-core/sync-registration';

import { resolveDoomConfigurationRoot } from '../../composition/repository';
import { readSyncDrift } from '../../composition/syncDrift';

/** Read only published generations. Export must never implicitly sync or activate a facet. */
export function exportApiContracts(options: {
  cwd: string;
  homeDirectory: string;
  outputDirectory: string;
  majorMode?: string;
}): ApiDocuments['manifest'] {
  const globalRoot = globalDoomConfigDirectory(options.homeDirectory);
  const workspaceRoot = resolveDoomConfigurationRoot(options.cwd, options.homeDirectory);
  const read = (root: string) => {
    const drift = readSyncDrift({ repoRoot: root, homeDirectory: options.homeDirectory });
    if (!drift.fresh)
      throw new Error(`Run doompi sync for '${root}' before exporting API contracts: ${drift.reasons.join(', ')}`);
    const registration = readSyncRegistration(root, options.homeDirectory);
    if (!registration?.serverBundle) throw new Error(`No synced server bundle for '${root}'`);
    const descriptor = parseDoomServerBundle(JSON.parse(fs.readFileSync(registration.serverBundle.path, 'utf8')));
    if (!descriptor.contracts) throw new Error(`Resync '${root}' to generate API contracts`);
    const file = path.resolve(path.dirname(registration.serverBundle.path), descriptor.contracts.file);
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== descriptor.contracts.sha256)
      throw new Error(`API contract checksum mismatch for '${root}'`);
    return {
      compiled: parseCompiledContracts(JSON.parse(bytes.toString('utf8'))),
      config: loadMajorModesConfig(root, options.homeDirectory),
    };
  };
  const global = read(globalRoot);
  const workspace = globalRoot === workspaceRoot ? global : read(workspaceRoot);
  const sessionMode = options.majorMode ?? workspace.config.defaultMajorMode;
  const selection = (
    source: typeof global,
    scope: ApiContractSelection['scope'],
    majorMode: string,
  ): ApiContractSelection => ({
    scope,
    majorMode,
    activeLayers: resolveLayers(source.config, majorMode),
    compiled: source.compiled,
  });
  // A typo must not silently export an empty session surface.
  if (!Object.hasOwn(workspace.config.majorMode, sessionMode)) throw new Error(`Unknown major mode '${sessionMode}'`);
  const documents = createApiDocuments([
    selection(global, 'global', global.config.defaultMajorMode),
    selection(workspace, 'workspace', workspace.config.defaultMajorMode),
    selection(workspace, 'session', sessionMode),
  ]);
  const files = {
    'openapi.json': canonicalContractJson(documents.openapi),
    'asyncapi.json': canonicalContractJson(documents.asyncapi),
  };
  const manifest = {
    ...documents.manifest,
    artifacts: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        {
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      ]),
    ),
  };
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  // Write the manifest last. Consumers verify both checksums before accepting the bundle.
  for (const [name, bytes] of Object.entries({ ...files, 'manifest.json': canonicalContractJson(manifest) })) {
    const target = path.join(options.outputDirectory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return documents.manifest;
}
