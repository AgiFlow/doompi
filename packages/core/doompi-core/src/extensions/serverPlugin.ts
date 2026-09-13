import { readDoomHeadlessHost } from '../schemas/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  requireDoomServerHost,
  type DoomServerFacet,
  type DoomServerPluginDefinition,
  type DoomServerPluginContext,
  type DoomServerSessionPlugin,
} from '../schemas/serverFacet';
import { createPluginLifecycle } from '../services/pluginLifecycle';

export function defineServerPlugin(plugin: DoomServerPluginDefinition): DoomServerFacet {
  return {
    inject: [...new Set([DOOM_SERVER_HOST_SERVICE, ...(plugin.inject ?? [])])],
    async apply(context) {
      const host = requireDoomServerHost(context);
      const declaration = plugin[host.scope];
      if (!declaration) return;
      const agent = host.scope === 'session' ? readDoomHeadlessHost(context) : undefined;
      const lifecycle = createPluginLifecycle<DoomServerPluginContext>((signal) => ({ context, host, agent, signal }));
      context.effect(() => () => lifecycle.dispose());
      const own = <T extends { dispose(): void | Promise<void>; mounted?: boolean }>(registration: T): void => {
        lifecycle.own(() => registration.dispose());
        if ('mounted' in registration && registration.mounted === false)
          throw new Error('Server plugin registration was refused.');
      };
      await lifecycle.mount(
        () => (typeof declaration === 'function' ? declaration(lifecycle.context) : declaration),
        async (scope) => {
          for (const service of scope.services ?? []) {
            const fiber = context.plugin(service);
            lifecycle.own(() => fiber.dispose());
            await fiber;
          }
          for (const channel of scope.channels ?? []) own(host.registerChannel(channel()));
          for (const api of scope.api ?? []) own(host.registerApi(api));
          for (const method of scope.methods ?? []) own(method.register(host));
          if (!agent) return;
          const session: DoomServerSessionPlugin = scope;
          for (const restriction of session.toolRestrictions ?? []) {
            if (!('restrict' in restriction)) {
              own(agent.registerToolRestriction(restriction));
              continue;
            }
            let registration: ReturnType<typeof agent.registerToolRestriction> | undefined;
            lifecycle.own(() => {
              const current = registration;
              registration = undefined;
              return current?.dispose();
            });
            const refresh = (): void => {
              if (lifecycle.context.signal.aborted) return;
              const previous = registration;
              registration = undefined;
              previous?.dispose();
              registration = agent.registerToolRestriction(restriction.restrict());
              if ('mounted' in registration && registration.mounted === false)
                throw new Error(`Server tool restriction ${restriction.source} was refused.`);
            };
            refresh();
            const unsubscribe = restriction.subscribe?.(refresh);
            if (unsubscribe) lifecycle.own(unsubscribe);
          }
          for (const resource of session.resources ?? []) own(agent.registerResource(resource));
          for (const tool of session.tools ?? []) {
            if ('kind' in tool) {
              own(
                agent.registerTool({
                  ...tool,
                  async execute(toolCallId, input, signal, update, execution) {
                    const invocationSignal = signal
                      ? AbortSignal.any([signal, lifecycle.context.signal])
                      : lifecycle.context.signal;
                    invocationSignal.throwIfAborted();
                    try {
                      return await tool.execute(input, {
                        toolCallId,
                        signal: invocationSignal,
                        cwd: execution.cwd,
                        update: (result) => update?.(result),
                        notify: (request) => execution.client.notify(request),
                      });
                    } catch (error) {
                      return {
                        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                        isError: true,
                      };
                    }
                  },
                }),
              );
            } else own(agent.registerTool(tool));
          }
          for (const command of session.commands ?? []) {
            if ('kind' in command) {
              own(
                agent.registerCommand({
                  ...command,
                  execute: (args, execution) => {
                    lifecycle.context.signal.throwIfAborted();
                    return command.execute(args, {
                      cwd: execution.cwd,
                      signal: lifecycle.context.signal,
                      notify: (request) => execution.client.notify(request),
                    });
                  },
                }),
              );
            } else own(agent.registerCommand(command));
          }
          for (const hook of session.hooks ?? []) own(agent.registerHook(hook));
          for (const activity of session.activities ?? []) own(agent.registerActivity(activity));
        },
      );
      return () => lifecycle.dispose();
    },
  };
}
