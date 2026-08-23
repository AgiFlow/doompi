import { BRIDGE_CONTAINER_PATH, BRIDGE_FILE_NAME } from './sandboxBridge.ts';

const IMAGE_REPOSITORY = 'doompi-sandbox';
const TAG_SAFE = /[^A-Za-z0-9_.-]/g;

/**
 * Names one image build: a distribution version plus its image definition.
 *
 * The digest matters as much as the version. Editing the Dockerfile or the
 * bridge without it would silently reuse a cached image that predates the
 * change.
 */
export function formatImageTag(version: string, digest: string): string {
  return `${IMAGE_REPOSITORY}:v${version.replaceAll(TAG_SAFE, '-')}-${digest}`;
}

/**
 * Self-contained Linux image for sandboxed sessions.
 *
 * nano is present because Pi falls back to it for the external editor when
 * VISUAL and EDITOR are unset, which is always the case here: a host editor
 * variable naming a desktop application would resolve to a binary the
 * container does not have, so it is deliberately not forwarded.
 *
 * The distribution installs from the registry rather than mounting host
 * modules: host installs carry platform-specific binaries a Linux container
 * cannot run. DOOMPI_SANDBOX is baked in so nothing that reaches a shell in
 * the container can present itself as an unsandboxed session.
 */
export function sandboxDockerfile(): string {
  return [
    'FROM node:22-bookworm-slim',
    'RUN apt-get update \\',
    '  && apt-get install -y --no-install-recommends ca-certificates curl git nano openssh-client ripgrep \\',
    '  && rm -rf /var/lib/apt/lists/*',
    'ARG DOOMPI_VERSION',
    'RUN npm install -g @agimon-ai/doompi@${DOOMPI_VERSION}',
    `COPY ${BRIDGE_FILE_NAME} ${BRIDGE_CONTAINER_PATH}`,
    '# World-writable so the launch can map any host user id onto it.',
    'RUN mkdir -m 0777 /doompi-home',
    'ENV DOOMPI_SANDBOX=1 HOME=/doompi-home',
    '',
  ].join('\n');
}
