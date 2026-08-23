FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

# pnpm is activated at build time as root, so no first-run hook has to write to
# a directory the container user cannot. COREPACK_HOME is shared rather than
# left in root's home, otherwise the unprivileged user re-downloads it.
ARG PNPM_VERSION=11.1.3
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && chmod -R a+rX "${COREPACK_HOME}"
