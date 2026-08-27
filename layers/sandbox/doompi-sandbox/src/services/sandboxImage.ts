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

/**
 * Image for the cockpit container, which holds the hub rather than one session.
 *
 * Kept separate from the sandbox image rather than folded into it. The cockpit
 * needs the web package and a tunnel client, and making every interactive
 * `--sandbox` launch pay for an extra apt repository and a larger download to
 * get them would be a poor trade.
 *
 * Installing `@agimon-ai/doompi-web` is enough for all three programs: it
 * depends on `@agimon-ai/doompi` and `@agimon-ai/doompi-server`, so the hub can
 * spawn sessions and each session can run an agent.
 */
export function cockpitDockerfile(): string {
  return [
    'FROM node:22-bookworm-slim',
    'RUN apt-get update \\',
    '  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg nano openssh-client ripgrep \\',
    '  && rm -rf /var/lib/apt/lists/*',
    // The tunnel runs beside the hub rather than on the host, so the cockpit
    // owns its own remote access and all of that state stays in one place.
    'RUN curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \\',
    '  -o /usr/share/keyrings/cloudflare-main.gpg \\',
    ' && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" \\',
    '  > /etc/apt/sources.list.d/cloudflared.list \\',
    ' && apt-get update && apt-get install -y --no-install-recommends cloudflared \\',
    ' && rm -rf /var/lib/apt/lists/*',
    'ARG DOOMPI_VERSION',
    'RUN npm install -g @agimon-ai/doompi-web@${DOOMPI_VERSION}',
    '# World-writable so the launch can map any host user id onto it.',
    'RUN mkdir -m 0777 /doompi-home',
    'ENV DOOMPI_SANDBOX=1 HOME=/doompi-home',
    '',
  ].join('\n');
}
