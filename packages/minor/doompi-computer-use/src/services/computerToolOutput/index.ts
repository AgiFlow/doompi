import type { DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';

import type { ComputerScriptExecutionResult } from '../../types/computerScript';
import type { ComputerUseObservation } from '../../types/computerUse';
import { ComputerScriptExecutionError } from '../computerScriptRunner';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;

function content(value: unknown, observation: ComputerUseObservation): DoomHeadlessToolResult['content'] {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('Computer-use text response exceeds the size limit.');
  const screenshot = observation.screenshot;
  if (screenshot && (screenshot.mimeType !== 'image/png' || screenshot.data.length > MAX_IMAGE_DATA_LENGTH)) {
    throw new Error('Computer-use screenshot exceeds the image limit.');
  }
  return [
    { type: 'text', text },
    ...(screenshot ? [{ type: 'image' as const, mimeType: screenshot.mimeType, data: screenshot.data }] : []),
  ];
}

export function computerObservationOutput(observation: ComputerUseObservation) {
  return { content: content({ ...observation, screenshot: undefined }, observation), details: observation };
}

export function computerScriptOutput(result: ComputerScriptExecutionResult) {
  try {
    return {
      content: content(
        { ...result, observation: { ...result.observation, screenshot: undefined } },
        result.observation,
      ),
      details: result,
    };
  } catch (error) {
    if (result.metrics === undefined) throw error;
    // Formatting happens after the actions complete. Preserve that progress so a caller does not replay them.
    throw new ComputerScriptExecutionError(
      error instanceof Error ? error.message : String(error),
      result.metrics.actions,
      false,
    );
  }
}

export function computerScriptFailure(error: unknown) {
  const details = {
    error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
    ...(error instanceof ComputerScriptExecutionError
      ? {
          completedActions: error.completedActions,
          outcomeUncertain: error.outcomeUncertain,
        }
      : {}),
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details, isError: true };
}
