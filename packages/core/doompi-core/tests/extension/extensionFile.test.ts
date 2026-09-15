import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

import {
  defineChannel,
  defineCommand,
  defineHook,
  defineServerTool,
  defineService,
  defineTool,
} from '../../src/extensions/extensionFile';

const Params = Type.Object({ query: Type.String() });

/**
 * The negative cases carry @ts-expect-error, so `tsc --noEmit` fails if a
 * shape these must reject ever starts type checking. That is the whole point
 * of the helpers: without them a routed file's default export reaches its
 * contribution array as `unknown`.
 */
describe('routed backend file contracts', () => {
  it('adds the discriminant a portable tool needs, for both the value and factory forms', () => {
    const value = defineTool({
      description: 'search',
      parameters: Params,
      execute: async () => ({ content: [] }),
    });
    expect(value).toMatchObject({ kind: 'tool' });

    const made = defineTool(() => ({
      description: 'search',
      parameters: Params,
      execute: async () => ({ content: [] }),
    }));
    expect(typeof made).toBe('function');
    expect((made as (context: unknown) => { kind: string })(undefined)).toMatchObject({ kind: 'tool' });
  });

  it('lets the path supply the name, and lets a file override it', () => {
    const derived = defineTool({ description: 'd', parameters: Params, execute: async () => ({ content: [] }) });
    expect(derived).not.toHaveProperty('name');

    const stated = defineTool({
      name: 'legacy_name',
      description: 'd',
      parameters: Params,
      execute: async () => ({ content: [] }),
    });
    expect(stated).toMatchObject({ name: 'legacy_name' });
  });

  it('passes a service and a native server tool through unchanged', () => {
    const plugin = (): void => undefined;
    expect(defineService(plugin)).toBe(plugin);

    const native = (): ReturnType<typeof makeNative> => makeNative();
    expect(defineServerTool(native)).toBe(native);
  });

  it('keeps a channel file a factory, because the contribution array holds one', () => {
    const channel = defineChannel(() => ({ start: () => ({ payloadFor: () => null, close: () => undefined }) }));
    expect(typeof channel).toBe('function');
  });

  it('rejects a tool that is missing the fields the host requires', () => {
    // @ts-expect-error parameters and execute are not optional
    expect(() => defineTool({ description: 'incomplete' })).not.toThrow();
  });

  it('rejects a misspelled key, which is what a bare object export would swallow', () => {
    expect(() =>
      defineTool({
        description: 'd',
        parameters: Params,
        execute: async () => ({ content: [] }),
        // @ts-expect-error `descriptionn` is not part of the contract
        descriptionn: 'typo',
      }),
    ).not.toThrow();
  });

  it('rejects a command shaped like a tool', () => {
    // @ts-expect-error a command executes with a string argument, not a schema
    expect(() => defineCommand({ description: 'd', parameters: Params })).not.toThrow();
  });

  it('narrows a hook handler when the file names its event', () => {
    const hook = defineHook<'session_start'>({
      event: 'session_start',
      handle: () => undefined,
    });
    expect(hook).toMatchObject({ event: 'session_start' });
  });
});

function makeNative(): {
  name: string;
  description: string;
  parameters: typeof Params;
  execute: () => Promise<{ content: [] }>;
} {
  return { name: 'grep', description: 'd', parameters: Params, execute: async () => ({ content: [] }) };
}
