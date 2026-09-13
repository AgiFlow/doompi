import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { hasPluginHelperCall, pluginCompositionWiring } from '../../src/rules/pluginWiring.js';

const roots: string[] = [];
function check(relative: string, source: string, packageName?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-wiring-'));
  roots.push(root);
  if (packageName) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: packageName }));
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return pluginCompositionWiring.check?.(file, root);
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('plugin composition wiring', () => {
  it('discovers typed factories through AST, excluding misleading text', () => {
    const parse = (text: string) => ts.createSourceFile('entry.ts', text, ts.ScriptTarget.Latest, true);
    expect(hasPluginHelperCall(parse('definePiExtension<Options>(name, factory)'), 'definePiExtension')).toBe(true);
    expect(
      hasPluginHelperCall(parse(`const text = 'definePiExtension('; // definePiExtension()`), 'definePiExtension'),
    ).toBe(false);
    expect(
      hasPluginHelperCall(
        parse(`import {definePiExtension as plugin} from 'contracts'; plugin<Options>(name, factory);`),
        'definePiExtension',
      ),
    ).toBe(true);
  });
  it('accepts scoped declarations and optional named lifecycle hooks', () => {
    expect(
      check(
        'src/extensions/server.ts',
        `export default defineServerPlugin({name: 'demo', session: {
      tools: [tool], onStart() { monitor.start(); }, onStop() { monitor.stop(); },
    }});`,
      ),
    ).toBeNull();
  });
  it('accepts flat Pi and isolated scope factories', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `export default definePiExtension('demo', () => {
      const controller = createController();
      return { tools: controller.tools, events: { session_start() {} }, onDispose() { controller.dispose(); } };
    });`,
      ),
    ).toBeNull();
    expect(
      check(
        'src/extensions/server.ts',
        `export default defineServerPlugin({name: 'demo', session: ctx => ({api: [api]})});`,
      ),
    ).toBeNull();
  });
  it('allows host methods on HOC-owned service contexts and their injected children', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `definePiExtension('demo', () => ({
      services: [(cordis: Context) => {
        cordis.inject(['service'], (ctx) => { ctx.on('event', listener); });
      }],
    }));`,
      ),
    ).toBeNull();
  });
  it('rejects raw Pi registration inside a service and unrelated shadowed contexts', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `definePiExtension('demo', () => ({
      services: [(cordis) => { pi.registerTool(tool); }],
    }));`,
      ),
    ).toContain('pi.registerTool');
    expect(
      check(
        'src/extensions/pi.ts',
        `definePiExtension('demo', () => ({
      services: [(cordis) => { const unowned = (cordis) => cordis.inject(['x'], callback); }],
    }));`,
      ),
    ).toContain('cordis.inject');
    expect(
      check(
        'src/extensions/pi.ts',
        `definePiExtension('demo', ({ context: cordis }) => {
      cordis.inject(['x'], callback); return {};
    });`,
      ),
    ).toContain('cordis.inject');
  });
  it('reserves the raw canonical Pi bootstrap for its exact host owner', () => {
    const bootstrap = 'export default function bootstrap(pi) { claimComposedGeneration(pi); }';
    expect(check('src/extensions/pi.ts', bootstrap, '@agimon-ai/doompi')).toBeNull();
    expect(check('src/extensions/pi.ts', bootstrap, '@agimon-ai/doompi-example')).toContain('definePiExtension');
    expect(check('src/extensions/server.ts', bootstrap, '@agimon-ai/doompi')).toContain('defineServerPlugin');
  });
  it('recognizes aliased helpers', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `import {definePiExtension as define} from '@agimon-ai/doompi-core/pi-extension';
      export default define({name:'demo', tools:[]});`,
      ),
    ).toBeNull();
  });
  it('rejects vanilla wiring even without a helper call', () => {
    expect(check('src/extensions/pi.ts', 'export default function activate(pi) { pi.registerTool(tool); }')).toContain(
      'Use definePiExtension',
    );
    expect(check('src/extensions/server.ts', 'export default {apply(ctx) {ctx.plugin(plugin);}}')).toContain(
      'Use defineServerPlugin',
    );
  });
  it('rejects manual host registration regardless of receiver name', () => {
    expect(
      check(
        'src/extensions/server.ts',
        `defineServerPlugin({name:'demo', session: ctx => {
      renamedHost.registerApi(api); ctx.get(SERVICE); return {};
    }});`,
      ),
    ).toContain('renamedHost.registerApi, ctx.get');
  });
  it('rejects manual Cordis initialization and aliased connectors', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `import {connectDoomCordisHost as connect} from 'host';
      definePiExtension({name:'demo', onStart() {connect(pi); new Context();}});`,
      ),
    ).toContain('connectDoomCordisHost, new Context');
  });
  it('rejects legacy lifecycle names and registrar callbacks in both layouts', () => {
    for (const entry of ['src/extensions/pi.ts', 'src/adapters/pi/extension.ts']) {
      expect(
        check(entry, `definePiExtension({source:'demo',setup() {}, tools(register) {register(tool);}});`),
      ).toContain('legacy lifecycle setup, imperative tools registration');
    }
    expect(
      check(
        'src/extensions/server.ts',
        `defineServerPlugin({name:'demo',session:()=>({teardown() {}, commands: register => {}})});`,
      ),
    ).toContain('legacy lifecycle teardown, imperative commands registration');
  });
  it('does not flag ordinary service methods outside declaration hooks', () => {
    expect(
      check(
        'src/extensions/pi.ts',
        `definePiExtension({name:'demo',onStart() {worker.start();},onStop() {worker.stop();}});`,
      ),
    ).toBeNull();
  });
  it('ignores core implementation and deleted paths', () => {
    expect(check('src/controllers/serverPlugin.ts', 'host.registerApi(api); context.get(SERVICE);')).toBeNull();
    expect(pluginCompositionWiring.check?.('/missing/src/extensions/pi.ts', '/missing')).toBeNull();
  });
});
