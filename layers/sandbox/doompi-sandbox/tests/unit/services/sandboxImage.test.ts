import { describe, expect, it } from 'vitest';
import { sandboxImageTag } from '../../../src/adapters/sandboxImageTag.ts';
import { formatImageTag, sandboxDockerfile } from '../../../src/services/sandboxImage.ts';

describe('formatImageTag', () => {
  it('joins the repository, version, and digest', () => {
    expect(formatImageTag('1.2.3', 'abcd1234')).toBe('doompi-sandbox:v1.2.3-abcd1234');
  });
});

describe('sandboxImageTag', () => {
  it('pins the tag to the distribution version', () => {
    expect(sandboxImageTag('0.0.1-alpha.36')).toMatch(/^doompi-sandbox:v0\.0\.1-alpha\.36-[0-9a-f]{8}$/);
  });

  it('sanitizes characters an image tag cannot carry', () => {
    expect(sandboxImageTag('1.0.0+build/7')).toMatch(/^doompi-sandbox:v1\.0\.0-build-7-[0-9a-f]{8}$/);
  });

  it('gives every version the same digest so a cached image is reused', () => {
    expect(sandboxImageTag('1.2.3')).toBe(sandboxImageTag('1.2.3'));
  });
});

describe('sandboxDockerfile', () => {
  it('installs the distribution from the registry and marks the environment', () => {
    const dockerfile = sandboxDockerfile();

    expect(dockerfile).toContain('FROM node:22-bookworm-slim');
    expect(dockerfile).toContain('npm install -g @agimon-ai/doompi@${DOOMPI_VERSION}');
    expect(dockerfile).toContain('ENV DOOMPI_SANDBOX=1 HOME=/doompi-home');
    expect(dockerfile).toContain('COPY sandbox-bridge.mjs /opt/doompi/sandbox-bridge.mjs');
  });
});
