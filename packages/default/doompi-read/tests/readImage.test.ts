import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyImageLimits } from '../src/adapters/pi/readImage.ts';
import { registerHashlineReadTool } from '../src/adapters/pi/readTool.ts';

interface CapturedTool {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<AgentToolResult<unknown>>;
}

let directory = '';
let home = '';
let tool: CapturedTool | undefined;
let previousHome: string | undefined;
let previousAgentDirectory: string | undefined;

/** A real PNG, because the resize pass decodes it rather than trusting the header. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = (x * 7) % 256;
      row[2 + x * 3] = (y * 11) % 256;
      row[3 + x * 3] = (x + y) % 256;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngWidth(base64: string): number {
  return Buffer.from(base64, 'base64').readUInt32BE(16);
}

function writeSettings(value: unknown): void {
  const filePath = join(home, '.pi', 'agent', 'settings.json');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

async function execute(path: string): Promise<AgentToolResult<unknown>> {
  if (!tool) throw new Error('Read tool was not registered');
  return tool.execute('call-1', { path }, undefined, undefined, { cwd: directory, model: undefined });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-read-image-'));
  home = await mkdtemp(join(tmpdir(), 'doompi-read-home-'));
  previousHome = process.env.HOME;
  previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  tool = undefined;
  registerHashlineReadTool({
    registerTool(registered) {
      tool = registered as unknown as CapturedTool;
    },
  } as Pick<ExtensionAPI, 'registerTool'>);
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDirectory !== undefined) process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  await rm(directory, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('read image limits', () => {
  it('resizes a read image to the configured cap and says how to map coordinates', async () => {
    writeSettings({ images: { maxDimension: 256 } });
    await writeFile(join(directory, 'wide.png'), png(512, 512));

    const result = await execute('wide.png');
    const image = result.content.find((part) => part.type === 'image');
    const notes = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

    expect(image).toBeDefined();
    expect(pngWidth((image as { data: string }).data)).toBe(256);
    expect(notes).toContain('displayed at 256x256');
  }, 20_000);

  it('hands back Pi is own bytes when the machine turned resizing off', async () => {
    writeSettings({ images: { autoResize: false, maxDimension: 256 } });
    const bytes = png(512, 512);
    await writeFile(join(directory, 'wide.png'), bytes);

    const result = await execute('wide.png');
    const image = result.content.find((part) => part.type === 'image');

    expect((image as { data: string }).data).toBe(bytes.toString('base64'));
  }, 20_000);

  it('leaves content without images untouched', async () => {
    const content = [{ type: 'text' as const, text: 'Read image file [image/png]' }];

    await expect(applyImageLimits(content, { autoResize: true, maxDimension: 256 })).resolves.toBe(content);
  });
});
