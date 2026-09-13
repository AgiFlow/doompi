import { parseApiContract, type DoomCompiledContracts } from '../../schemas/apiContracts';
import type { DoomApiScope } from '../../schemas/packageApi';

export interface ApiContractSelection {
  scope: DoomApiScope;
  majorMode: string;
  activeLayers: readonly string[];
  compiled: DoomCompiledContracts;
}

export interface ApiDocuments {
  openapi: Record<string, unknown>;
  asyncapi: Record<string, unknown>;
  manifest: {
    version: 1;
    complete: boolean;
    protocols: Record<string, string>;
    selections: {
      scope: DoomApiScope;
      majorMode: string;
      activeLayers: string[];
      generation: string;
      fingerprint: string;
    }[];
    packages: { name: string; version: string; scope: DoomApiScope }[];
    gaps: { packageName: string; scope: DoomApiScope; reason: string }[];
    dynamic: string[];
  };
}

/** Stable bytes for diffs and hashes, independent of object insertion order. */
export function canonicalContractJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([key, child]) => [key, ordered(child)]),
      );
    return item;
  };
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

const componentName = (value: string): string =>
  value.replace(/[^a-zA-Z0-9.-]/gu, (character) => `_${character.codePointAt(0)!.toString(16)}_`);
const pluginPrefix = (scope: DoomApiScope): string =>
  scope === 'global'
    ? '/api/global/plugin'
    : scope === 'workspace'
      ? '/api/workspaces/{workspaceId}/plugin'
      : '/api/sessions/{sessionId}/plugin';

/** Compose declarations only. No handlers, lifecycle hooks, or platform resources are loaded. */
export function createApiDocuments(selections: readonly ApiContractSelection[]): ApiDocuments {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const channelMessages: Record<string, unknown> = {};
  const manifest: ApiDocuments['manifest'] = {
    version: 1,
    complete: true,
    protocols: {},
    selections: [],
    packages: [],
    gaps: [],
    dynamic: [],
  };
  const socketAddresses = new Set<string>();
  const schema = (id: string, value: unknown): { $ref: string } => {
    const name = componentName(id);
    if (schemas[name] !== undefined) throw new Error(`Conflicting schema: ${id}`);
    // Local $defs references must remain local after moving into components.
    const relocate = (child: unknown): unknown => {
      if (Array.isArray(child)) return child.map(relocate);
      if (child === null || typeof child !== 'object') return child;
      return Object.fromEntries(
        Object.entries(child).map(([key, entry]) => {
          if (key === '$id') throw new Error(`Schema ${id} must use local references, not $id`);
          if (key === '$ref' && typeof entry === 'string') {
            if (!entry.startsWith('#/')) throw new Error(`Unresolved schema reference in ${id}: ${entry}`);
            return [key, `#/components/schemas/${name}${entry.slice(1)}`];
          }
          return [key, relocate(entry)];
        }),
      );
    };
    schemas[name] = relocate(value);
    return { $ref: `#/components/schemas/${name}` };
  };
  for (const selected of [...selections].sort((a, b) => a.scope.localeCompare(b.scope))) {
    manifest.selections.push({
      scope: selected.scope,
      majorMode: selected.majorMode,
      activeLayers: [...selected.activeLayers].sort(),
      generation: selected.compiled.generation,
      fingerprint: selected.compiled.fingerprint,
    });
    for (const entry of [...selected.compiled.packages].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
      if (
        !entry.scopes.includes(selected.scope) ||
        !entry.owners.some(
          (owner) =>
            owner.majorMode === selected.majorMode &&
            (owner.layer === 'default' || selected.activeLayers.includes(owner.layer)),
        )
      )
        continue;
      manifest.packages.push({ name: entry.packageName, version: entry.packageVersion, scope: selected.scope });
      if (!entry.contract || entry.problem) {
        manifest.gaps.push({
          packageName: entry.packageName,
          scope: selected.scope,
          reason: entry.problem ?? 'No contract declaration',
        });
        continue;
      }
      const contract = parseApiContract(entry.contract);
      for (const [name, value] of Object.entries(contract.schemas ?? {}))
        schema(`${entry.packageName}.${selected.scope}.${name}`, value);
      for (const [name, version] of Object.entries(contract.protocols ?? {})) {
        if (manifest.protocols[name] !== undefined && manifest.protocols[name] !== version)
          throw new Error(`Conflicting ${name} protocol versions`);
        manifest.protocols[name] = version;
      }
      manifest.gaps.push(
        ...(contract.gaps ?? []).map((reason) => ({ packageName: entry.packageName, scope: selected.scope, reason })),
      );
      manifest.dynamic.push(...contract.dynamic.map((value) => `${entry.packageName}: ${value}`));
      for (const route of contract.http.filter((route) => route.scope === selected.scope)) {
        const id = `${entry.packageName}.${route.scope}.${route.id}`;
        const mount = route.basePath === undefined ? '' : `${pluginPrefix(route.scope)}/${route.basePath}`;
        const pathname = `${mount}${route.path}`;
        const method = route.method.toLowerCase();
        const path = (paths[pathname] ??= {});
        if (path[method]) throw new Error(`Conflicting HTTP contract: ${route.method} ${pathname}`);
        const parameters = (route.parameters ?? []).map((parameter) => ({
          ...parameter,
          schema: schema(`${id}.${parameter.in}.${parameter.name}`, parameter.schema),
        }));
        for (const match of pathname.matchAll(/\{([^}]+)\}/gu)) {
          if (!parameters.some((parameter) => parameter.in === 'path' && parameter.name === match[1]))
            parameters.push({
              name: match[1],
              in: 'path',
              required: true,
              schema: schema(`${id}.path.${match[1]}`, { type: 'string', minLength: 1 }),
            });
        }
        path[method] = {
          operationId: componentName(id),
          description: route.description,
          parameters,
          security: route.authentication === 'none' ? [] : [{ [route.authentication]: [] }],
          'x-doompi': {
            packageName: entry.packageName,
            scope: route.scope,
            ...(route.availability ? { availability: route.availability } : {}),
          },
          ...(route.body
            ? {
                requestBody: {
                  required: route.body.required,
                  content: Object.fromEntries(
                    (route.body.contentTypes ?? [route.body.contentType]).map((mediaType) => [
                      mediaType,
                      { schema: schema(`${id}.body.${mediaType}`, route.body!.schema) },
                    ]),
                  ),
                },
              }
            : {}),
          responses: Object.fromEntries(
            Object.entries(route.responses).map(([status, response]) => [
              status,
              {
                description: response.description,
                ...(response.events
                  ? {
                      'x-sse-events': Object.fromEntries(
                        Object.entries(response.events).map(([name, payload]) => [
                          name,
                          schema(`${id}.event.${name}`, payload),
                        ]),
                      ),
                    }
                  : {}),
                ...(response.schema === undefined
                  ? {}
                  : {
                      content: {
                        [response.contentType ?? 'application/json']: {
                          schema: schema(`${id}.response.${status}`, response.schema),
                        },
                      },
                    }),
              },
            ]),
          ),
        };
      }
      for (const socket of contract.sockets.filter((socket) => socket.scope === selected.scope)) {
        const address = `${socket.scope}:${socket.direction}:${socket.kind}:${socket.service}:${socket.member}`;
        if (socketAddresses.has(address)) throw new Error(`Conflicting socket contract: ${address}`);
        socketAddresses.add(address);
        const id = componentName(`${entry.packageName}.${socket.scope}.${socket.id}`);
        const addMessage = (suffix: string, payload: unknown): string => {
          const name = `${id}.${suffix}`;
          messages[name] = { name, payload: schema(name, payload) };
          channelMessages[name] = { $ref: `#/components/messages/${name}` };
          return `#/channels/pi/messages/${name}`;
        };
        const request = addMessage('input', socket.input);
        const replies = socket.output === undefined ? [] : [{ $ref: addMessage('output', socket.output) }];
        if (socket.errors !== undefined) replies.push({ $ref: addMessage('error', socket.errors) });
        operations[id] = {
          action: socket.direction === 'client-to-server' ? 'receive' : 'send',
          channel: { $ref: '#/channels/pi' },
          messages: [{ $ref: request }],
          description: socket.description,
          ...(replies.length ? { reply: { channel: { $ref: '#/channels/pi' }, messages: replies } } : {}),
          'x-doompi': {
            service: socket.service,
            member: socket.member,
            scope: socket.scope,
            kind: socket.kind,
            ...(socket.availability ? { availability: socket.availability } : {}),
          },
        };
      }
    }
  }
  manifest.complete = manifest.gaps.length === 0;
  manifest.dynamic = [...new Set(manifest.dynamic)].sort();
  const info = { title: 'DoomPi compiled client API', version: '1' };
  const openapi = {
    openapi: '3.1.1',
    info,
    paths,
    components: {
      schemas: openApiSchemas(schemas),
      securitySchemes: {
        owner: { type: 'apiKey', in: 'header', name: 'x-doompi-token' },
        device: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-doompi_device',
          description:
            'Admitted device credentials and purpose-bound sealed channel; see remote authentication operations.',
        },
      },
    },
  };
  const asyncapi = {
    asyncapi: '3.0.0',
    info,
    channels: {
      pi: {
        address: '/api/pi',
        messages: channelMessages,
        description:
          'Decoded Pi/Chord application values. Local WebSocket messages carry length-prefixed CBOR bytes. Remote paired-device WebSocket messages carry UTF-8 JSON SealedEnvelope bytes whose decrypted payload contains the same Pi frames.',
      },
    },
    operations,
    components: { schemas: asyncApiSchemas(schemas), messages },
  };
  // References must resolve in each portable document before either is published.
  for (const document of [openapi, asyncapi]) {
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') {
          let target: unknown = document;
          for (const segment of child.slice(2).split('/')) {
            if (target === null || typeof target !== 'object') throw new Error(`Unresolved API reference: ${child}`);
            target = Reflect.get(target, segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
          }
          if (target === undefined) throw new Error(`Unresolved API reference: ${child}`);
        } else visit(child);
      }
    };
    visit(document);
  }
  return { openapi, asyncapi, manifest };
}

/** TypeBox uses draft-07 tuple keywords; OpenAPI 3.1 evaluates the 2020-12 vocabulary. */
function openApiSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(openApiSchemas);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'items' && Array.isArray(child)) {
      if (child.length) result.prefixItems = child.map(openApiSchemas);
      else {
        result.items = false;
        result.maxItems = 0;
      }
    } else if (key === 'additionalItems' && Array.isArray(source.items)) result.items = openApiSchemas(child);
    else if (key === 'dependencies' && child !== null && typeof child === 'object') {
      const required: Record<string, unknown> = {};
      const schemas: Record<string, unknown> = {};
      for (const [name, dependency] of Object.entries(child)) {
        if (Array.isArray(dependency)) required[name] = dependency;
        else schemas[name] = openApiSchemas(dependency);
      }
      if (Object.keys(required).length) result.dependentRequired = required;
      if (Object.keys(schemas).length) result.dependentSchemas = schemas;
    } else if (key === '$schema') result.$schema = 'https://json-schema.org/draft/2020-12/schema';
    else result[key] = openApiSchemas(child);
  }
  return result;
}

function asyncApiSchemas(schemas: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (value === null || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        result[key] = child.replace(/^(#\/components\/schemas\/[^/]+)(.*)$/u, '$1/schema$2');
      } else if (key === 'items' && Array.isArray(child) && child.length === 0) {
        result.items = false;
        result.maxItems = 0;
      } else result[key] = convert(child);
    }
    return result;
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      {
        schemaFormat: 'application/schema+json;version=draft-07',
        schema: convert(schema),
      },
    ]),
  );
}
