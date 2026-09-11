/**
 * The server host a facet contributes to.
 *
 * DESIGN PATTERNS:
 * - One mount table. Every facet registers through this service, so the host
 *   process has a single ordered record of what is mounted and under what.
 * - Base paths are first-come. A collision is reported and skipped, so one
 *   misdeclared package cannot take a server down.
 * - Handlers are started lazily on first mount and closed on dispose, so a
 *   facet that registers and immediately unwinds leaves nothing running.
 *
 * AVOID:
 * - Letting a throwing `start` escape. A package whose API cannot start is
 *   reported and skipped; the remaining facets still mount.
 * - Reaching for node:*. The host owns the listener; this only owns the table.
 */

import type { DoomHubChannel, DoomHubChannelHost, DoomHubChannelSource } from '../schemas/hubChannel.ts';
import type { DoomApi, DoomApiContext, DoomApiHandler, DoomApiScope } from '../schemas/packageApi.ts';
import type { DoomServerHostService, DoomServerRegistration } from '../schemas/serverFacet.ts';

interface MountedApi {
  readonly basePath: string;
  readonly handler: DoomApiHandler;
}

interface MountedChannel {
  readonly channel: DoomHubChannel;
  readonly source?: DoomHubChannelSource;
  readonly registration?: DoomServerRegistration;
}

export interface CreateDoomServerHostOptions {
  scope: DoomApiScope;
  context: DoomApiContext;
  /** Required when facets may register live channels. */
  channelHost?: DoomHubChannelHost;
  /** Supplies a channel-specific host when one host serves multiple channels. */
  channelHostFor?: (channel: DoomHubChannel) => DoomHubChannelHost;
  /** Delegates channel mounting to an owner of the canonical channel table. */
  mountChannel?: (channel: DoomHubChannel) => DoomServerRegistration;
  /** Called when an API mount table entry appears or disappears. */
  onChange?: (mounted: readonly string[]) => void;
  /** Called when a channel mount table entry appears or disappears. */
  onChannelsChange?: (mounted: readonly string[]) => void;
}

/** The mount table a server host exposes to its facets, plus the router's read side. */
export interface DoomServerHost extends DoomServerHostService {
  /** The handler owning a base path, for the router that dispatches to it. */
  handlerFor(basePath: string): DoomApiHandler | undefined;
  /** Close every mounted handler and empty the table. */
  dispose(): void;
}

export function createDoomServerHost(options: CreateDoomServerHostOptions): DoomServerHost {
  const { scope, context } = options;
  const notice = (message: string): void => context.onNotice(message);
  const mounts: MountedApi[] = [];
  const channels: MountedChannel[] = [];
  let disposed = false;

  const changed = (): void => options.onChange?.(mounts.map((mount) => mount.basePath));
  const channelsChanged = (): void => options.onChannelsChange?.(channels.map((mount) => mount.channel.frameType));

  const noop: DoomServerRegistration = { mounted: false, dispose: () => undefined };

  const registerApi = (api: DoomApi): DoomServerRegistration => {
    if (disposed) {
      notice(`package API '${api.basePath}' is skipped: the server host is already disposed.`);
      return noop;
    }
    const holder = mounts.find((mount) => mount.basePath === api.basePath);
    if (holder !== undefined) {
      notice(`package API '${api.basePath}' is skipped: another facet already claims it.`);
      return noop;
    }
    let handler: DoomApiHandler;
    try {
      handler = api.start(context);
    } catch (error) {
      notice(`package API '${api.basePath}' did not start (${String(error)}); it is skipped.`);
      return noop;
    }
    const mount: MountedApi = { basePath: api.basePath, handler };
    mounts.push(mount);
    changed();
    let released = false;
    return {
      mounted: true,
      dispose: () => {
        if (released) return;
        released = true;
        const index = mounts.indexOf(mount);
        if (index >= 0) mounts.splice(index, 1);
        try {
          handler.close();
        } catch (error) {
          notice(`package API '${mount.basePath}' did not close cleanly (${String(error)}).`);
        }
        changed();
      },
    };
  };

  const registerChannel = (channel: DoomHubChannel): DoomServerRegistration => {
    if (disposed) {
      notice(`hub channel '${channel.frameType}' is skipped: the server host is already disposed.`);
      return noop;
    }
    if (options.mountChannel !== undefined) {
      let registration: DoomServerRegistration;
      try {
        registration = options.mountChannel(channel);
      } catch (error) {
        notice(`hub channel '${channel.frameType}' did not mount (${String(error)}); it is skipped.`);
        return noop;
      }
      if (registration.mounted !== true) return registration;
      const mount: MountedChannel = { channel, registration };
      channels.push(mount);
      channelsChanged();
      let released = false;
      return {
        mounted: true,
        dispose: () => {
          if (released) return;
          released = true;
          const index = channels.indexOf(mount);
          if (index >= 0) channels.splice(index, 1);
          try {
            registration.dispose();
          } catch (error) {
            notice(`hub channel '${channel.frameType}' did not close cleanly (${String(error)}).`);
          }
          channelsChanged();
        },
      };
    }
    const channelHost = options.channelHostFor?.(channel) ?? options.channelHost;
    if (!channelHost) {
      notice(`hub channel '${channel.frameType}' is skipped: this server host has no channel capability.`);
      return noop;
    }
    if (channels.some((mount) => mount.channel.frameType === channel.frameType)) {
      notice(`hub channel '${channel.frameType}' is skipped: another facet already claims it.`);
      return noop;
    }
    let source: DoomHubChannelSource;
    try {
      source = channel.start(channelHost);
    } catch (error) {
      notice(`hub channel '${channel.frameType}' did not start (${String(error)}); it is skipped.`);
      return noop;
    }
    const mount: MountedChannel = { channel, source };
    channels.push(mount);
    channelsChanged();
    let released = false;
    return {
      mounted: true,
      dispose: () => {
        if (released) return;
        released = true;
        const index = channels.indexOf(mount);
        if (index >= 0) channels.splice(index, 1);
        try {
          source.close();
        } catch (error) {
          notice(`hub channel '${channel.frameType}' did not close cleanly (${String(error)}).`);
        }
        channelsChanged();
      },
    };
  };

  return {
    scope,
    context,
    registerApi,
    registerChannel,
    mounted: () => mounts.map((mount) => mount.basePath),
    mountedChannels: () => channels.map((mount) => mount.channel.frameType),
    handlerFor: (basePath) => mounts.find((mount) => mount.basePath === basePath)?.handler,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const mount of channels.splice(0).reverse()) {
        try {
          if (mount.registration !== undefined) mount.registration.dispose();
          else mount.source?.close();
        } catch (error) {
          notice(`hub channel '${mount.channel.frameType}' did not close cleanly (${String(error)}).`);
        }
      }
      for (const mount of mounts.splice(0).reverse()) {
        try {
          mount.handler.close();
        } catch (error) {
          notice(`package API '${mount.basePath}' did not close cleanly (${String(error)}).`);
        }
      }
      channelsChanged();
      changed();
    },
  };
}
