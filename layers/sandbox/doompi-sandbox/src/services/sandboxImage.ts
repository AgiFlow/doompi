const IMAGE_REPOSITORY = 'doompi-sandbox';
const TAG_SAFE = /[^A-Za-z0-9_.-]/g;

/** Image tag pinned to one distribution version, so upgrades rebuild. */
export function sandboxImageTag(version: string): string {
  return `${IMAGE_REPOSITORY}:v${version.replaceAll(TAG_SAFE, '-')}`;
}

/**
 * Self-contained Linux image for sandboxed sessions.
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
    '  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep \\',
    '  && rm -rf /var/lib/apt/lists/*',
    'ARG DOOMPI_VERSION',
    'RUN npm install -g @agimon-ai/doompi@${DOOMPI_VERSION}',
    '# World-writable so the launch can map any host user id onto it.',
    'RUN mkdir -m 0777 /doompi-home',
    'ENV DOOMPI_SANDBOX=1 HOME=/doompi-home',
    '',
  ].join('\n');
}
