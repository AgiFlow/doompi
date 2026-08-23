import { describe, expect, it } from 'vitest';
import { sandboxDockerfile, sandboxImageTag } from '../../../src/services/sandboxImage.ts';

describe('sandboxImageTag', () => {
  it('pins the tag to the distribution version', () => {
    expect(sandboxImageTag('0.0.1-alpha.36')).toBe('doompi-sandbox:v0.0.1-alpha.36');
  });

  it('sanitizes characters an image tag cannot carry', () => {
    expect(sandboxImageTag('1.0.0+build/7')).toBe('doompi-sandbox:v1.0.0-build-7');
  });
});

describe('sandboxDockerfile', () => {
  it('installs the distribution from the registry and marks the environment', () => {
    const dockerfile = sandboxDockerfile();

    expect(dockerfile).toContain('FROM node:22-bookworm-slim');
    expect(dockerfile).toContain('npm install -g @agimon-ai/doompi@${DOOMPI_VERSION}');
    expect(dockerfile).toContain('ENV DOOMPI_SANDBOX=1 HOME=/doompi-home');
  });
});
