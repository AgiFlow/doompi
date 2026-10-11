import path from 'node:path';

import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import { writeSessionAttachment, type DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { Value } from 'typebox/value';

import { SaveFileParameters, ShareFileParameters } from '../../schemas/fileTransfer';
import { decodeFileBase64, downloadPublicFile } from './download';
import { writeCwdFile } from './storage';

export function createFileTransferTools(owner?: DoomServerPluginContext): DoomHeadlessTool[] {
  return [
    {
      // web-plugin-tool-renderers: ignore share_file, remote-only file transfer
      name: 'share_file',
      description: 'Publish a session file as a short-lived public download link. No consent prompt.',
      parameters: ShareFileParameters,
      _meta: { 'doompi/fileTransfer': true },
      async execute(_id, input, signal) {
        const executionSignal = AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(owner?.signal ? [owner.signal] : []),
        ]);
        executionSignal.throwIfAborted();
        if (!Value.Check(ShareFileParameters, input)) throw new Error('Invalid share_file parameters.');
        const host = owner?.host.context;
        if (!host?.shareFile) throw new Error('File sharing is unavailable.');
        const shared = await host.shareFile(input.path, 'share_file');
        if (executionSignal.aborted) {
          shared.revoke();
          executionSignal.throwIfAborted();
        }
        const result = {
          url: shared.url,
          fileName: shared.fileName,
          mimeType: shared.mimeType,
          size: shared.size,
          expiresAt: shared.expiresAt,
          maxDownloads: shared.maxDownloads,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
      },
    },
    {
      // web-plugin-tool-renderers: ignore save_file, remote-only file transfer
      name: 'save_file',
      description:
        'Save a public HTTPS file (25 MiB maximum) or base64 file (5 MiB maximum) to session attachments or a new relative cwd path.',
      parameters: SaveFileParameters,
      _meta: { 'doompi/fileTransfer': true, 'openai/fileParams': ['file'] },
      async execute(_id, input, cancellation) {
        if (!Value.Check(SaveFileParameters, input)) throw new Error('Provide exactly one file form.');
        const context = owner?.agent?.context;
        if (!context) throw new Error('Session file storage is unavailable.');
        const signal = AbortSignal.any([
          ...(cancellation ? [cancellation] : []),
          ...(owner?.signal ? [owner.signal] : []),
        ]);
        signal.throwIfAborted();
        const file = input.file;
        const bytes =
          'download_url' in file
            ? await downloadPublicFile(file.download_url, signal)
            : decodeFileBase64(file.data_base64);
        signal.throwIfAborted();
        const name = 'download_url' in file ? file.file_name : file.name;
        const result =
          input.path === undefined
            ? await writeSessionAttachment(context.sessionId, name, bytes, context.environment)
            : {
                path: await writeCwdFile(context.cwd, input.path, bytes),
                name: path.basename(input.path),
                size: bytes.length,
                mimeType: 'application/octet-stream',
              };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } };
      },
    },
  ];
}
