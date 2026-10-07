import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import type { DoomSharedFile } from '@agimon-ai/doompi-core/packageApi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConsentedFilePublisher,
  fileParamNames,
  modelInputSchema,
  publishFileParams,
} from '../../../src/services/mcpFileParams';
import type { McpFileParamTool } from '../../../src/services/mcpFileParams/type';

const PATH_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

const uploadTool: McpFileParamTool = {
  serverName: 'agiflow',
  toolName: 'upload',
  inputSchema: {
    type: 'object',
    properties: {
      artifact: { type: 'object', description: 'The artifact to attach.' },
      note: { type: 'string' },
    },
    required: ['artifact'],
  },
  _meta: { 'openai/fileParams': ['artifact'] },
};

function sharedFile(name = 'report.pdf') {
  return {
    url: `https://tunnel.example/mcp-file/${'a'.repeat(43)}`,
    fileName: name,
    mimeType: 'application/pdf',
    size: 2048,
    revoke: vi.fn<() => void>(),
  } satisfies DoomSharedFile;
}

describe('fileParamNames', () => {
  it('keeps declared names that are top-level schema properties', () => {
    expect(fileParamNames(uploadTool)).toEqual(['artifact']);
  });

  it.each([
    ['a non-array declaration', 'artifact'],
    ['non-string entries', [42, null, { name: 'artifact' }]],
    ['undeclared properties', ['missing', 'nested.artifact']],
  ])('ignores %s', (_label, declared) => {
    expect(fileParamNames({ ...uploadTool, _meta: { 'openai/fileParams': declared } })).toEqual([]);
  });

  it('ignores a declaration when the schema has no properties', () => {
    expect(fileParamNames({ ...uploadTool, inputSchema: {} })).toEqual([]);
  });

  it('caps the declared names at 16', () => {
    const names = Array.from({ length: 20 }, (_, index) => `file${index}`);
    const tool = {
      ...uploadTool,
      inputSchema: { type: 'object', properties: Object.fromEntries(names.map((name) => [name, {}])) },
      _meta: { 'openai/fileParams': names },
    };
    expect(fileParamNames(tool)).toEqual(names.slice(0, 16));
  });
});

describe('modelInputSchema', () => {
  it('replaces each file parameter with a path object and keeps the rest', () => {
    const schema = modelInputSchema(uploadTool);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        artifact: {
          ...PATH_SCHEMA,
          description:
            'The artifact to attach. Pass {"path": "<file in the working directory, or the path from an Attached file note>"}.',
        },
        note: { type: 'string' },
      },
      required: ['artifact'],
    });
    expect(uploadTool.inputSchema.properties).toHaveProperty('artifact.type', 'object');
    expect(uploadTool.inputSchema.properties).not.toHaveProperty('artifact.properties');
  });

  it('describes an undocumented file parameter as a file', () => {
    const tool = { ...uploadTool, inputSchema: { type: 'object', properties: { artifact: {} } } };
    expect(modelInputSchema(tool)).toHaveProperty(
      'properties.artifact.description',
      'A file. Pass {"path": "<file in the working directory, or the path from an Attached file note>"}.',
    );
  });

  it('returns the original schema without file parameters, and an open object for an empty one', () => {
    const plain = { ...uploadTool, _meta: undefined };
    expect(modelInputSchema(plain)).toBe(plain.inputSchema);
    expect(modelInputSchema({ ...plain, inputSchema: {} })).toEqual({ type: 'object', properties: {} });
  });
});

describe('publishFileParams', () => {
  it('rewrites path values on a copy and releases every minted link', async () => {
    const file = sharedFile();
    const publish = vi.fn().mockResolvedValue(file);
    const params = { artifact: { path: 'docs/report.pdf' }, note: 'q3' };

    const files = await publishFileParams(uploadTool, params, publish);

    expect(publish).toHaveBeenCalledExactlyOnceWith('docs/report.pdf');
    expect(files.outbound).toEqual({
      artifact: {
        file_id: expect.stringMatching(/^doomfile_[0-9a-f-]{36}$/u),
        download_url: file.url,
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
      },
      note: 'q3',
    });
    expect(params).toEqual({ artifact: { path: 'docs/report.pdf' }, note: 'q3' });
    expect(file.revoke).not.toHaveBeenCalled();
    files.release();
    files.release();
    expect(file.revoke).toHaveBeenCalledOnce();
  });

  it('passes through values that are not path objects, including a ChatGPT-shaped file', async () => {
    const publish = vi.fn();
    const chatGptFile = { file_id: 'file_1', download_url: 'https://cdn.example/f', file_name: 'f', mime_type: 'x' };
    const params = { artifact: chatGptFile };

    const files = await publishFileParams(uploadTool, params, publish);

    expect(files.outbound).toEqual(params);
    expect(publish).not.toHaveBeenCalled();
  });

  it('leaves tools without file parameters untouched, even with no publisher', async () => {
    const params = { artifact: { path: 'docs/report.pdf' } };
    const files = await publishFileParams({ ...uploadTool, _meta: undefined }, params);
    expect(files.outbound).toBe(params);
  });

  it('fails with a clear message when no publisher is available', async () => {
    await expect(publishFileParams(uploadTool, { artifact: { path: 'a.pdf' } })).rejects.toThrow(
      'This MCP tool takes a file, which needs the DoomPi web host with remote access on.',
    );
  });

  it('revokes what it already minted when a later share fails', async () => {
    const first = sharedFile('a.pdf');
    const tool = {
      ...uploadTool,
      inputSchema: { type: 'object', properties: { first: {}, second: {} } },
      _meta: { 'openai/fileParams': ['first', 'second'] },
    };
    const publish = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('declined'));

    await expect(
      publishFileParams(tool, { first: { path: 'a.pdf' }, second: { path: 'b.pdf' } }, publish),
    ).rejects.toThrow('declined');
    expect(first.revoke).toHaveBeenCalledOnce();
  });
});

describe('createConsentedFilePublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function host(answer: (signal?: AbortSignal) => Promise<unknown>) {
    const request = vi.fn((_request: unknown, signal?: AbortSignal) => answer(signal));
    const appendCustomEntry = vi.fn().mockResolvedValue(undefined);
    const service = {
      context: { client: { request }, session: { appendCustomEntry } },
    } as unknown as DoomHeadlessHostService;
    return { service, request, appendCustomEntry };
  }

  const tool = { serverName: 'agiflow', toolName: 'upload' };

  it('returns the share only after the user approves, and audits without the link', async () => {
    const file = sharedFile();
    const shareFile = vi.fn().mockResolvedValue(file);
    const approving = host(async () => true);
    const publish = createConsentedFilePublisher({ shareFile, host: () => approving.service });

    await expect(publish('docs/report.pdf', tool)).resolves.toBe(file);

    expect(shareFile).toHaveBeenCalledExactlyOnceWith('docs/report.pdf', 'agiflow / upload');
    expect(approving.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 'confirm',
        title: 'Share a file with an MCP server?',
        message:
          'Share "report.pdf" (2048 bytes) with agiflow / upload? DoomPi publishes it at a link on your remote-access tunnel until this call finishes (10 minutes at most). Cloudflare and agiflow can read the file.',
      },
      expect.any(AbortSignal),
    );
    expect(approving.appendCustomEntry).toHaveBeenCalledExactlyOnceWith('mcp.file.share', {
      file: 'report.pdf',
      server: 'agiflow',
      tool: 'upload',
      outcome: 'shared',
    });
    expect(JSON.stringify(approving.appendCustomEntry.mock.calls)).not.toContain(file.url);
    expect(file.revoke).not.toHaveBeenCalled();
  });

  it('revokes and refuses when the user declines', async () => {
    const file = sharedFile();
    const declining = host(async () => false);
    const publish = createConsentedFilePublisher({ shareFile: async () => file, host: () => declining.service });

    await expect(publish('docs/report.pdf', tool)).rejects.toThrow('The user declined to share "report.pdf".');
    expect(file.revoke).toHaveBeenCalledOnce();
    expect(declining.appendCustomEntry).toHaveBeenCalledWith(
      'mcp.file.share',
      expect.objectContaining({ outcome: 'declined' }),
    );
  });

  it('fails closed when nobody answers within two minutes', async () => {
    vi.useFakeTimers();
    const file = sharedFile();
    const silent = host(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const publish = createConsentedFilePublisher({ shareFile: async () => file, host: () => silent.service });

    const pending = publish('docs/report.pdf', tool);
    const settled = expect(pending).rejects.toThrow('The user declined to share "report.pdf".');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(file.revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(file.revoke).toHaveBeenCalledOnce();
    expect(silent.appendCustomEntry).toHaveBeenCalledWith(
      'mcp.file.share',
      expect.objectContaining({ outcome: 'unanswered' }),
    );
  });

  it('fails closed when the call or the session is cancelled while asking', async () => {
    const file = sharedFile();
    const controller = new AbortController();
    const pendingHost = host(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const publish = createConsentedFilePublisher({ shareFile: async () => file, host: () => pendingHost.service });

    const pending = publish('docs/report.pdf', tool, controller.signal);
    controller.abort(new Error('stopped'));

    await expect(pending).rejects.toThrow('declined');
    expect(file.revoke).toHaveBeenCalledOnce();
  });

  it('revokes and refuses when no client can be asked', async () => {
    const file = sharedFile();
    const publish = createConsentedFilePublisher({ shareFile: async () => file, host: () => undefined });

    await expect(publish('docs/report.pdf', tool)).rejects.toThrow('no DoomPi client');
    expect(file.revoke).toHaveBeenCalledOnce();
  });

  it('revokes an approved share when the audit cannot be written', async () => {
    const file = sharedFile();
    const approving = host(async () => true);
    approving.appendCustomEntry.mockRejectedValue(new Error('session closed'));
    const publish = createConsentedFilePublisher({ shareFile: async () => file, host: () => approving.service });

    await expect(publish('docs/report.pdf', tool)).rejects.toThrow('session closed');
    expect(file.revoke).toHaveBeenCalledOnce();
  });

  it('asks nothing when the host refuses to publish', async () => {
    const asking = host(async () => true);
    const publish = createConsentedFilePublisher({
      shareFile: async () => {
        throw new Error('Remote access is off');
      },
      host: () => asking.service,
    });

    await expect(publish('.env', tool)).rejects.toThrow('Remote access is off');
    expect(asking.request).not.toHaveBeenCalled();
  });
});
