import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { TeamPiScope } from '../../_lib/root.cli';

type Command = readonly [string, Parameters<ExtensionAPI['registerCommand']>[1]];

export function readyCommand(root: TeamPiScope, [name, options]: Command): Command {
  return [
    name,
    {
      ...options,
      async handler(args, context) {
        await root.waitForSessionReadiness(context);
        return options.handler(args, context);
      },
    },
  ];
}
