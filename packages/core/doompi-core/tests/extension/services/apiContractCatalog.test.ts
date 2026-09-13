import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import { Parser } from '@asyncapi/parser';
import { expect, it } from 'vitest';

import { parseApiContract, type DoomCompiledContracts } from '../../../src/schemas/apiContracts';
import { canonicalContractJson, createApiDocuments } from '../../../src/services/apiContracts';

it('exports every repository server facet contract as a complete, standards-valid catalog', async () => {
  const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const compiled: DoomCompiledContracts = {
    version: 1,
    generation: 'catalog',
    fingerprint: 'a'.repeat(64),
    packages: [],
  };
  for (const manifestFile of fs
    .globSync(['packages/*/*/package.json', 'layers/*/*/package.json'], { cwd: root })
    .sort()) {
    const directory = path.dirname(path.join(root, manifestFile));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      doompiServer?: { scopes: ('global' | 'workspace' | 'session')[]; contracts?: { entry: string; dist: string } };
    };
    if (!manifest.doompiServer) continue;
    expect(manifest.doompiServer.contracts, manifest.name).toBeDefined();
    const declaration = manifest.doompiServer.contracts!;
    // Import only the data entry, never the server facet or a handler.
    const module = (await import(pathToFileURL(path.join(directory, declaration.entry)).href)) as { default: unknown };
    compiled.packages.push({
      packageName: manifest.name,
      packageVersion: manifest.version,
      scopes: manifest.doompiServer.scopes,
      owners: [{ majorMode: 'catalog', layer: 'default' }],
      contract: parseApiContract(JSON.parse(JSON.stringify(module.default))),
    });
  }
  expect(compiled.packages.length).toBeGreaterThan(30);
  const documents = createApiDocuments(
    (['global', 'workspace', 'session'] as const).map((scope) => ({
      scope,
      majorMode: 'catalog',
      activeLayers: [],
      compiled,
    })),
  );
  expect(documents.manifest.gaps).toEqual([]);
  expect(documents.manifest.complete).toBe(true);
  await SwaggerParser.validate(JSON.parse(canonicalContractJson(documents.openapi)));
  const parsed = await new Parser().parse(canonicalContractJson(documents.asyncapi));
  expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 0)).toEqual([]);
}, 30000);
