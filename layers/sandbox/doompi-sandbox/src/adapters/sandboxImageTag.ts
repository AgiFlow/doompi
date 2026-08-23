import { createHash } from 'node:crypto';
import { sandboxBridgeSource } from '../services/sandboxBridge.ts';
import { formatImageTag, sandboxDockerfile } from '../services/sandboxImage.ts';

const DIGEST_LENGTH = 8;

/** Tags the image with the distribution version and a digest of its definition. */
export function sandboxImageTag(version: string): string {
  const digest = createHash('sha256')
    .update(sandboxDockerfile())
    .update(sandboxBridgeSource())
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
  return formatImageTag(version, digest);
}
