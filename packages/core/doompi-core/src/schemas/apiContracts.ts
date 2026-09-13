import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import type { DoomApiScope } from './packageApi';
import type { DoomServerBundleOwner } from './serverBundle';

export const DOOM_API_CONTRACT_VERSION = 1;
export const DOOM_API_CONTRACT_FILE = 'contracts.json';
const Schema = Type.Unsafe<object | boolean>(Type.Union([Type.Boolean(), Type.Record(Type.String(), Type.Unknown())]));
const Scope = Type.Union([Type.Literal('global'), Type.Literal('workspace'), Type.Literal('session')]);
const Named = Type.String({ minLength: 1 });
const ResponseSchema = Type.Object({
  description: Named,
  contentType: Type.Optional(Named),
  schema: Type.Optional(Schema),
  events: Type.Optional(Type.Record(Named, Schema)),
});

/** Data-only package entry. Schemas use JSON Schema draft-07, including TypeBox output; OpenAPI export translates tuple keywords. */
export const DoomApiContractSchema = Type.Object({
  version: Type.Literal(DOOM_API_CONTRACT_VERSION),
  protocols: Type.Optional(Type.Record(Named, Named)),
  schemas: Type.Optional(Type.Record(Named, Schema)),
  http: Type.Array(
    Type.Object({
      id: Named,
      scope: Scope,
      /** Omit for host-owned absolute routes. */
      basePath: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' })),
      path: Type.String({ pattern: '^/' }),
      method: Type.Union([
        Type.Literal('GET'),
        Type.Literal('POST'),
        Type.Literal('PUT'),
        Type.Literal('PATCH'),
        Type.Literal('DELETE'),
        Type.Literal('HEAD'),
        Type.Literal('OPTIONS'),
      ]),
      description: Named,
      availability: Type.Optional(Named),
      authentication: Type.Union([Type.Literal('none'), Type.Literal('owner'), Type.Literal('device')]),
      parameters: Type.Optional(
        Type.Array(
          Type.Object({
            name: Named,
            in: Type.Union([Type.Literal('path'), Type.Literal('query'), Type.Literal('header')]),
            required: Type.Boolean(),
            schema: Schema,
          }),
        ),
      ),
      body: Type.Optional(
        Type.Object({
          contentType: Named,
          contentTypes: Type.Optional(Type.Array(Named, { minItems: 1 })),
          required: Type.Boolean(),
          schema: Schema,
        }),
      ),
      responses: Type.Record(Type.String({ pattern: '^(?:[1-5][0-9]{2}|default)$' }), ResponseSchema, {
        minProperties: 1,
      }),
    }),
  ),
  sockets: Type.Array(
    Type.Object({
      id: Named,
      scope: Scope,
      description: Named,
      availability: Type.Optional(Named),
      service: Named,
      member: Named,
      direction: Type.Union([Type.Literal('client-to-server'), Type.Literal('server-to-client')]),
      kind: Type.Union([Type.Literal('method'), Type.Literal('state'), Type.Literal('channel')]),
      input: Schema,
      output: Type.Optional(Schema),
      errors: Type.Optional(Schema),
    }),
  ),
  /** Explicitly enumerate dynamic values whose shape is supplied at runtime. */
  dynamic: Type.Array(Type.String({ minLength: 1 })),
  gaps: Type.Optional(Type.Array(Named)),
});

export type DoomApiContract = Static<typeof DoomApiContractSchema>;
export type DoomHttpContract = DoomApiContract['http'][number];
export type DoomSocketContract = DoomApiContract['sockets'][number];

export function defineApiContract(contract: DoomApiContract): DoomApiContract {
  return contract;
}

export function parseApiContract(value: unknown): DoomApiContract {
  if (!Check(DoomApiContractSchema, value)) throw new Error('Invalid DoomPi API contract');
  const contract = value as DoomApiContract;
  const ids = new Set<string>();
  for (const entry of [...contract.http, ...contract.sockets]) {
    const key = `${entry.scope}:${entry.id}`;
    if (ids.has(key)) throw new Error(`Duplicate API contract operation: ${key}`);
    ids.add(key);
  }
  // Reject non-JSON data rather than silently losing it during export.
  const visit = (item: unknown, ancestors: Set<object>): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error('API contracts must contain finite JSON data');
    ancestors.add(item);
    for (const child of Object.values(item)) visit(child, ancestors);
    ancestors.delete(item);
  };
  visit(contract, new Set());
  return contract;
}

export interface DoomPackageContract {
  packageName: string;
  packageVersion: string;
  scopes: readonly DoomApiScope[];
  owners: readonly DoomServerBundleOwner[];
  contract?: DoomApiContract;
  problem?: string;
  /** Generation-relative compiler output, never imported by the export command. */
  module?: string;
}

export interface DoomCompiledContracts {
  version: typeof DOOM_API_CONTRACT_VERSION;
  generation: string;
  fingerprint: string;
  packages: DoomPackageContract[];
}

export function parseCompiledContracts(value: unknown): DoomCompiledContracts {
  const PackageSchema = Type.Object({
    packageName: Named,
    packageVersion: Named,
    scopes: Type.Array(Scope, { uniqueItems: true }),
    owners: Type.Array(Type.Object({ majorMode: Named, layer: Named }), { minItems: 1 }),
    contract: Type.Optional(DoomApiContractSchema),
    problem: Type.Optional(Named),
    module: Type.Optional(Type.String({ pattern: '^\\./[^\\\\%?#]+$' })),
  });
  const CompiledSchema = Type.Object({
    version: Type.Literal(DOOM_API_CONTRACT_VERSION),
    generation: Named,
    fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    packages: Type.Array(PackageSchema),
  });
  if (!Check(CompiledSchema, value)) throw new Error('Invalid compiled API contracts');
  const data = value as DoomCompiledContracts;
  const names = new Set<string>();
  for (const entry of data.packages) {
    if (names.has(entry.packageName) || entry.module?.split('/').includes('..'))
      throw new Error('Invalid compiled package contract');
    names.add(entry.packageName);
    if (entry.contract !== undefined) parseApiContract(entry.contract);
  }
  return data;
}
