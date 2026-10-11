import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 25 * 1024 * 1024;
/** Conservative public-address allowlist. IPv6 is limited to global unicast, excluding special ranges. */
export function isPublicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  return net.isIP(address) === 6 && /^[23]/u.test(address) && !/^(2001:|2002:|3fff:)/iu.test(address);
}

export async function downloadPublicFile(input: string, cancellation?: AbortSignal): Promise<Buffer> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(cancellation ? [cancellation] : [])]);
  let url = new URL(input);
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Only public HTTPS URLs without credentials are accepted.');
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await new Promise<Awaited<ReturnType<typeof dns.lookup>>[]>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          dns
            .lookup(hostname, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
          if (signal.aborted) abort();
        });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
      throw new Error('URL must resolve only to public addresses.');
    const pinned = addresses[0];
    const result = await new Promise<Buffer | URL>((resolve, reject) => {
      const request = https.get(
        url,
        {
          signal,
          agent: false,
          lookup: (_host, options, callback) => {
            if (typeof options === 'object' && options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy();
            if (redirects >= 3 || !response.headers.location)
              reject(new Error('Too many redirects or missing redirect location.'));
            else {
              try {
                resolve(new URL(response.headers.location, url));
              } catch (error) {
                reject(error);
              }
            }
            return;
          }
          if (status !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {
            response.destroy();
            reject(new Error('Download refused: status or size limit.'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) response.destroy(new Error('Download exceeds 25 MiB.'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Download response was interrupted.')));
          response.on('close', () => {
            if (!response.complete) reject(new Error('Download response was interrupted.'));
          });
          response.on('end', () => resolve(Buffer.concat(chunks, size)));
        },
      );
      request.on('error', reject);
    });
    if (Buffer.isBuffer(result)) return result;
    url = result;
  }
}

export function decodeFileBase64(data: string): Buffer {
  if (
    data.length > 4 * Math.ceil((5 * 1024 * 1024) / 3) ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  )
    throw new Error('Invalid or oversized base64 file.');
  const size = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (size < 0 || (data.includes('=') && data.length < 4)) throw new Error('Invalid base64 padding.');
  if (size > 5 * 1024 * 1024) throw new Error('Base64 file exceeds 5 MiB.');
  return Buffer.from(data, 'base64');
}
