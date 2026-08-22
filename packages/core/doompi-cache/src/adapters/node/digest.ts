import { createHash } from 'node:crypto';

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
