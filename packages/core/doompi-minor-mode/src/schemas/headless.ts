import type {
  MinorModeArguments,
  MinorModeDescriptor,
  MinorModeState,
  MinorModeOwnerActionResult,
  MinorModeSessionKind,
} from './mode';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
export interface DoomHeadlessMinorMode {
  descriptor: MinorModeDescriptor;
  initialState: MinorModeState;
  handleAction(
    actionId: string,
    args: MinorModeArguments,
    execution: {
      context: DoomHeadlessExecutionContext;
      operationId: string;
      sessionKind: MinorModeSessionKind;
      signal: AbortSignal;
    },
  ): MinorModeOwnerActionResult | void | Promise<MinorModeOwnerActionResult | void>;
  onError?(error: unknown): void;
}
