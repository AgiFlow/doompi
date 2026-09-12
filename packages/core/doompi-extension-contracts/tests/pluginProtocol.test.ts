import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  createDoomPluginRegistry,
  defineDoomPluginMethod,
  DoomPluginCallError,
  invokeDoomPluginMethod,
} from '../src/exports/pluginProtocol';

const Read = defineDoomPluginMethod({
  service: 'example.documents',
  method: 'read',
  scope: 'workspace',
  direction: 'client-to-server',
  input: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  output: Type.Object({ title: Type.String() }, { additionalProperties: false }),
});

describe('plugin protocol', () => {
  it('round trips through an exact workspace mount with typed input and output', async () => {
    const registry = createDoomPluginRegistry();
    const mount = { scope: 'workspace' as const, workspaceId: 'work-a' };
    registry.register(mount, Read, ({ id }) => ({ title: `Document ${id}` }));
    const result = await invokeDoomPluginMethod((call) => registry.invoke(call, 'client-to-server'), mount, Read, {
      id: '42',
    });
    expect(result.title).toBe('Document 42');
    await expect(
      registry.invoke(
        {
          mount: { scope: 'workspace', workspaceId: 'work-b' },
          service: Read.service,
          method: Read.method,
          input: { id: '42' },
        },
        'client-to-server',
      ),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(
      registry.invoke(
        { mount: { scope: 'global' }, service: Read.service, method: Read.method, input: { id: '42' } },
        'client-to-server',
      ),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    registry.dispose();
  });

  it('rejects malformed calls and payloads on both boundaries', async () => {
    const registry = createDoomPluginRegistry();
    const mount = { scope: 'workspace' as const, workspaceId: 'work-a' };
    registry.register(mount, Read, () => ({ title: 'ok' }));
    await expect(
      registry.invoke(
        { mount: { scope: 'workspace' }, service: Read.service, method: Read.method, input: { id: '42' } },
        'client-to-server',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CALL' });
    await expect(
      registry.invoke({ mount, service: Read.service, method: Read.method, input: { id: 42 } }, 'client-to-server'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(invokeDoomPluginMethod(async () => ({ title: 42 }), mount, Read, { id: '42' })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
    expect(() => registry.register({ scope: 'global' }, Read, () => ({ title: 'bad' }))).toThrow(
      'requires workspace scope',
    );
    expect(DoomPluginCallError).toBeDefined();
  });

  it('enforces direction, duplicate ownership, and disposal', async () => {
    const registry = createDoomPluginRegistry();
    const mount = { scope: 'workspace' as const, workspaceId: 'work-a' };
    const release = registry.register(mount, Read, () => ({ title: 'first' }));
    expect(() => registry.register(mount, Read, () => ({ title: 'second' }))).toThrow('already mounted');
    await expect(
      registry.invoke({ mount, service: Read.service, method: Read.method, input: { id: '42' } }, 'server-to-client'),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    release();
    await expect(
      registry.invoke({ mount, service: Read.service, method: Read.method, input: { id: '42' } }, 'client-to-server'),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    registry.dispose();
    expect(() => registry.register(mount, Read, () => ({ title: 'later' }))).toThrow('disposed');
  });
});
