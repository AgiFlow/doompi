import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

/** A schema-checked native tool whose concrete input/details types stay inside its registration closure. */
export interface PiToolDeclaration {
  readonly kind: 'pi-tool';
  readonly name: string;
  register(pi: Pick<ExtensionAPI, 'registerTool'>, executionSignal?: () => AbortSignal): void;
}

export function definePiTool<TParameters extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
): PiToolDeclaration {
  return {
    kind: 'pi-tool',
    name: definition.name,
    register(pi, executionSignal) {
      if (!executionSignal) {
        pi.registerTool(definition);
        return;
      }
      pi.registerTool({
        ...definition,
        async execute(toolCallId, input, signal, update, context) {
          const current = executionSignal();
          current.throwIfAborted();
          return definition.execute(
            toolCallId,
            input,
            signal ? AbortSignal.any([signal, current]) : current,
            update,
            context,
          );
        },
      });
    },
  };
}
