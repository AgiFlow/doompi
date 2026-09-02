import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { carriesUserImages, shrinkUserImages } from '../../src/adapters/promptImages.ts';

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

function imageFrame(type: string, bytes: Buffer): Record<string, unknown> {
  return {
    type,
    message: 'look at this',
    images: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
  };
}

function firstImage(frame: Record<string, unknown>): { data: string; mimeType: string } {
  return (frame.images as { data: string; mimeType: string }[])[0]!;
}

describe('user image limits', () => {
  it('claims the three frames a page sends images on, and nothing else', () => {
    const bytes = png(4, 4);
    expect(carriesUserImages(imageFrame('prompt', bytes))).toBe(true);
    expect(carriesUserImages(imageFrame('steer', bytes))).toBe(true);
    expect(carriesUserImages(imageFrame('follow_up', bytes))).toBe(true);
    expect(carriesUserImages({ type: 'prompt', message: 'no images' })).toBe(false);
    expect(carriesUserImages(imageFrame('get_state', bytes))).toBe(false);
    expect(carriesUserImages({ type: 'prompt', images: ['not an image block'] })).toBe(false);
  });

  it('resizes an attached image to the cap and reports the coordinate mapping', async () => {
    const frame = imageFrame('prompt', png(512, 512));

    const shrunk = await shrinkUserImages(frame, { autoResize: true, maxDimension: 256 });

    expect(Buffer.from(firstImage(shrunk).data, 'base64').readUInt32BE(16)).toBe(256);
    expect(shrunk.message).toContain('look at this');
    expect(shrunk.message).toContain('displayed at 256x256');
  });

  it('forwards the frame untouched when it already fits, or when resizing is off', async () => {
    const small = imageFrame('prompt', png(8, 8));

    await expect(shrinkUserImages(small, { autoResize: true, maxDimension: 256 })).resolves.toBe(small);
    const large = imageFrame('follow_up', png(512, 512));
    await expect(shrinkUserImages(large, { autoResize: false, maxDimension: 256 })).resolves.toBe(large);
  });
});
