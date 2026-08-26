import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { type WebLocation, collectSpecifiers, locate, readSource, relativeTarget } from './moduleGraph.js';

const CLIENT_LAYER_ORDER: Readonly<Record<string, number | undefined>> = {
  types: 0,
  lib: 1,
  stores: 2,
  components: 3,
  features: 4,
  routes: 5,
  app: 6,
};
const SERVER_LAYER_ORDER: Readonly<Record<string, number | undefined>> = {
  types: 0,
  services: 1,
  adapters: 2,
  bin: 3,
  exports: 4,
};

const CLIENT_ORDER_LABEL = 'types, lib, stores, components, features, routes, app';
const SERVER_ORDER_LABEL = 'types, services, adapters, bin, exports';

/** src/types is the shared contract, so it is the one server root the bundle may read. */
const SERVER_ROOTS_CLOSED_TO_CLIENT = new Set(['services', 'adapters', 'bin', 'exports']);
const SERVER_ROOTS_CLOSED_TO_WEB = new Set(['services', 'adapters', 'bin']);

function label(location: WebLocation): string {
  if (location.side === 'client') return location.layer ? `src/web/${location.layer}` : 'src/web';
  return location.layer ? `src/${location.layer}` : 'src';
}

function violation(source: WebLocation, target: WebLocation, specifier: string): string | undefined {
  const pair = `${label(source)} may not import ${label(target)} ('${specifier}')`;

  if (source.side === 'client' && target.side === 'server') {
    return SERVER_ROOTS_CLOSED_TO_CLIENT.has(target.layer ?? '')
      ? `${pair}. Browser code may not reach server code. Call the server over HTTP or RPC and keep the shared contract in src/types.`
      : undefined;
  }
  if (source.side === 'server' && target.side === 'client') {
    return SERVER_ROOTS_CLOSED_TO_WEB.has(source.layer ?? '')
      ? `${pair}. Server code may not reach the browser bundle. Keep the shared contract in src/types and let the client import it from there.`
      : undefined;
  }

  const order = source.side === 'client' ? CLIENT_LAYER_ORDER : SERVER_LAYER_ORDER;
  const from = source.layer === undefined ? undefined : order[source.layer];
  const to = target.layer === undefined ? undefined : order[target.layer];
  if (from === undefined || to === undefined || to <= from) return undefined;

  return source.side === 'client'
    ? `${pair}. The client layer order is ${CLIENT_ORDER_LABEL} and no layer may import a higher one. Move the shared code down to a lower layer, or hand it in as a prop, a store value, or a route parameter.`
    : `${pair}. The server layer order is ${SERVER_ORDER_LABEL} and no layer may import a higher one. Declare the contract in src/types and let the higher layer inject the implementation.`;
}

export const doomWebLayerBoundary: RuleDefinition = {
  preflight: true,
  rule: 'Web layers point inward and the browser bundle never meets the server outside src/types',
  rationale:
    'A web package ships two programs from one source tree. Left unseparated they merge: a component reaches a service for one field, the bundler follows it, and server credentials, filesystem access, and node builtins land in the browser. Direction inside each tree matters for the same reason: when a component imports a feature, the reusable half now depends on the specific one and neither can be moved or deleted alone. Keep the shared vocabulary in src/types, where both sides can read it without dragging an implementation across.',
  check(filePath, configRoot) {
    const source = locate(filePath, configRoot);
    if (!source) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const messages = new Set<string>();
    for (const specifier of collectSpecifiers(sourceFile)) {
      const target = relativeTarget(filePath, specifier, configRoot);
      if (!target) continue;
      const message = violation(source, target, specifier);
      if (message) messages.add(message);
    }

    return messages.size > 0 ? [...messages].join(' ') : null;
  },
};
