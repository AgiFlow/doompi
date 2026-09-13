import SwaggerParser from '@apidevtools/swagger-parser';
import { Parser } from '@asyncapi/parser';
import { describe, expect, it } from 'vitest';

import { parseApiContract, type DoomApiContract } from '../../../src/schemas/apiContracts';
import { builtinApiContract } from '../../../src/schemas/builtinApiContracts';
import {
  createApiDocuments,
  canonicalContractJson,
  type ApiContractSelection,
} from '../../../src/services/apiContracts';

const contract: DoomApiContract = {
  version: 1,
  http: [
    {
      id: 'items',
      scope: 'workspace',
      basePath: 'example',
      path: '/items/{itemId}',
      method: 'POST',
      authentication: 'owner',
      description: 'Create an item',
      body: {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      responses: {
        '201': {
          description: 'Created',
          schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      },
    },
  ],
  sockets: [],
  dynamic: [],
};
function selection(value: DoomApiContract = contract): ApiContractSelection {
  return {
    scope: 'workspace',
    majorMode: 'copilot',
    activeLayers: ['task'],
    compiled: {
      version: 1,
      generation: 'test',
      fingerprint: 'a'.repeat(64),
      packages: [
        {
          packageName: '@example/test',
          packageVersion: '1',
          scopes: ['workspace'],
          owners: [{ majorMode: 'copilot', layer: 'task' }],
          contract: value,
        },
      ],
    },
  };
}

describe('compiled API documents', () => {
  it('uses scoped paths, stable operation names and self-contained references', () => {
    const documents = createApiDocuments([selection()]);
    expect(documents.manifest.complete).toBe(true);
    expect(documents.openapi).toMatchObject({
      openapi: '3.1.1',
      paths: {
        '/api/workspaces/{workspaceId}/plugin/example/items/{itemId}': {
          post: {
            parameters: expect.arrayContaining([
              expect.objectContaining({ name: 'workspaceId', in: 'path', required: true }),
              expect.objectContaining({ name: 'itemId', required: true }),
            ]),
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    });
    expect(canonicalContractJson(documents)).toBe(canonicalContractJson(createApiDocuments([selection()])));
    expect(canonicalContractJson({ z: 1, a: 2 })).toBe(canonicalContractJson({ a: 2, z: 1 }));
  });
  it('filters unselected owners and does not fall through scopes', () => {
    const selected = selection();
    selected.activeLayers = [];
    expect(createApiDocuments([selected]).openapi.paths).toEqual({});
    selected.scope = 'global';
    expect(createApiDocuments([selected]).manifest.packages).toEqual([]);
  });
  it('reports missing and partial contracts as incomplete', () => {
    const selected = selection();
    delete selected.compiled.packages[0]!.contract;
    expect(createApiDocuments([selected]).manifest).toMatchObject({
      complete: false,
      gaps: [{ packageName: '@example/test', scope: 'workspace' }],
    });
    expect(createApiDocuments([selection({ ...contract, gaps: ['Missing event schema'] })]).manifest.complete).toBe(
      false,
    );
  });
  it('rejects conflicting routes, duplicate identifiers, non-JSON data and unresolved references', () => {
    const selected = selection();
    selected.compiled.packages.push({ ...selected.compiled.packages[0]!, packageName: '@example/collision' });
    expect(() => createApiDocuments([selected])).toThrow('Conflicting HTTP');
    expect(() => parseApiContract({ ...contract, http: [...contract.http, ...contract.http] })).toThrow('Duplicate');
    expect(() => parseApiContract({ ...contract, dynamic: [undefined] })).toThrow();
    expect(() =>
      createApiDocuments([
        selection({
          ...contract,
          http: [
            {
              ...contract.http[0]!,
              body: { contentType: 'application/json', required: true, schema: { $ref: '#/$defs/missing' } },
            },
          ],
        }),
      ]),
    ).toThrow('Unresolved');
  });
  it('relocates nested schema references when namespacing', () => {
    const selected = selection({
      ...contract,
      http: [
        {
          ...contract.http[0]!,
          body: {
            contentType: 'application/json',
            required: true,
            schema: {
              type: 'object',
              properties: { name: { $ref: '#/$defs/name' } },
              $defs: { name: { type: 'string' } },
            },
          },
        },
      ],
    });
    expect(() => createApiDocuments([selected])).not.toThrow();
  });
  it('exports built-in HTTP and all declared session methods without loading handlers', () => {
    const selected = selection(builtinApiContract);
    selected.compiled.packages[0]!.scopes = ['global', 'workspace', 'session'];
    const documents = createApiDocuments(
      ['global', 'workspace', 'session'].map((scope) => ({ ...selected, scope }) as ApiContractSelection),
    );
    expect(documents.openapi.paths).toHaveProperty('/api/health');
    expect(Object.keys(documents.asyncapi.operations as object).some((name) => name.endsWith('session.prompt'))).toBe(
      true,
    );
  });
});

it('validates the generated documents with independent standards parsers', async () => {
  const selected = selection(builtinApiContract);
  selected.compiled.packages[0]!.scopes = ['global', 'workspace', 'session'];
  const documents = createApiDocuments(
    ['global', 'workspace', 'session'].map((scope) => ({ ...selected, scope }) as ApiContractSelection),
  );
  await SwaggerParser.validate(JSON.parse(canonicalContractJson(documents.openapi)));
  const parsed = await new Parser().parse(canonicalContractJson(documents.asyncapi));
  expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 0)).toEqual([]);
  expect(parsed.document).toBeDefined();
}, 30000);
