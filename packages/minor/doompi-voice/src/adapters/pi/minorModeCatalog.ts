import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  MINOR_MODE_ERROR_CODE,
  MINOR_MODE_TOOL_NAME,
  type MinorModeActionResponse,
  type MinorModeArguments,
  createMinorModeCatalogClient,
  type MinorModeCatalogSnapshot,
  type MinorModeRecord,
  type MinorModeRegistrationRef,
  type MinorModeToolInput,
  MinorModeToolInputSchema,
  MinorModeToolResultSchema,
  requireMinorModeCatalog,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { DoomProtocolError } from '@agimon-ai/doompi-extension-contracts/protocol';
import type { VoiceToolDefinition } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const PACKAGE_SOURCE = '@agimon-ai/doompi-voice';

export interface VoiceMinorModeCatalog {
  snapshot(): MinorModeCatalogSnapshot | undefined;
  records(): readonly MinorModeRecord[] | undefined;
  invoke(
    mode: MinorModeRegistrationRef,
    actionId: string,
    argumentsValue: MinorModeArguments,
    signal: AbortSignal,
  ): Promise<MinorModeActionResponse>;
  dispose(): void;
}

function required(value: string | undefined, name: string): string {
  if (value) return value;
  throw new DoomProtocolError({
    code: MINOR_MODE_ERROR_CODE.invalidArguments,
    message: `${name} is required when action is invoke.`,
  });
}

function registration(input: MinorModeToolInput): MinorModeRegistrationRef {
  return {
    source: required(input.source, 'source'),
    id: required(input.id, 'id'),
    ownerGeneration: required(input.ownerGeneration, 'ownerGeneration'),
    registrationId: required(input.registrationId, 'registrationId'),
  };
}

export function createMinorModeVoiceTool(catalog: VoiceMinorModeCatalog): VoiceToolDefinition<ExtensionContext> {
  return {
    descriptor: {
      source: PACKAGE_SOURCE,
      id: MINOR_MODE_TOOL_NAME,
      name: MINOR_MODE_TOOL_NAME,
      label: 'Minor Mode',
      description:
        'List independently registered Doompi minor modes, or invoke one advertised action using the exact registration reference returned by list.',
      order: 0,
      inputSchema: MinorModeToolInputSchema,
      resultSchema: MinorModeToolResultSchema,
    },
    async execute(input, execution) {
      const params = input as MinorModeToolInput;
      if (params.action === 'list') {
        const snapshot = catalog.snapshot();
        if (snapshot) return snapshot;
        throw new DoomProtocolError({
          code: MINOR_MODE_ERROR_CODE.sessionReplaced,
          message: 'The minor-mode catalog is not active for this session.',
          retryable: true,
        });
      }
      return catalog.invoke(
        registration(params),
        required(params.modeAction, 'modeAction'),
        params.arguments ?? {},
        execution.signal,
      );
    },
  };
}

export function createVoiceMinorModeCatalog(cordis: Context): VoiceMinorModeCatalog {
  let client: ReturnType<typeof createMinorModeCatalogClient> | undefined;
  let disposed = false;
  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
    if (disposed) return;
    const activeClient = createMinorModeCatalogClient(requireMinorModeCatalog(modeContext));
    client = activeClient;
    return () => {
      if (client === activeClient) client = undefined;
    };
  });
  return {
    snapshot: () => client?.getSnapshot(),
    records: () => client?.getSnapshot().modes,
    invoke: (mode, actionId, argumentsValue, signal) => {
      const activeClient = client;
      if (!activeClient) {
        throw new DoomProtocolError({
          code: MINOR_MODE_ERROR_CODE.sessionReplaced,
          message: 'The minor-mode catalog is not active for this session.',
          retryable: true,
        });
      }
      return activeClient.invoke(mode, actionId, argumentsValue, { signal });
    },
    dispose() {
      disposed = true;
      client = undefined;
    },
  };
}
