import { createHash } from 'node:crypto';
import { sandboxBridgeSource } from '../services/sandboxBridge.ts';
import { cockpitDockerfile, formatImageTag, sandboxDockerfile } from '../services/sandboxImage.ts';

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

/**
 * Tags the cockpit image separately from the sandbox one.
 *
 * Same digest scheme, different definition, so editing either Dockerfile
 * invalidates only its own image.
 */
export function cockpitImageTag(version: string): string {
  const digest = createHash('sha256').update(cockpitDockerfile()).digest('hex').slice(0, DIGEST_LENGTH);
  return formatImageTag(`${version}-cockpit`, digest);
}
