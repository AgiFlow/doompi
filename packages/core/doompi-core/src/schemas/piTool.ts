import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

/** A schema-checked native tool whose concrete input/details types stay inside its registration closure. */
export interface PiToolDeclaration {
  readonly kind: 'pi-tool';
  readonly name: string;
  /**
   * Claims a name another extension already registers, rather than adding one.
   *
   * Pi ships its own grep, read and edit, so a package that improves one of
   * them is replacing a name rather than contributing a new one. Only one
   * package may win a given name, which is why this is a claim arbitrated by
   * the tool-override service and not simply a second registration.
   */
  readonly overrides?: boolean;
  register(pi: Pick<ExtensionAPI, 'registerTool'>, executionSignal?: () => AbortSignal): void;
}

export interface PiToolOptions {
  /** Replace a name another extension registers instead of adding a new one. */
  readonly overrides?: boolean;
}

export function definePiTool<TParameters extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParameters, TDetails, TState>,
  options: PiToolOptions = {},
): PiToolDeclaration {
  return {
    kind: 'pi-tool',
    name: definition.name,
    ...(options.overrides === true ? { overrides: true } : {}),
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
