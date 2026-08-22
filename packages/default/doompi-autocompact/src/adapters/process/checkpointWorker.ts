import { parentPort, workerData } from 'node:worker_threads';

type PiCodingAgentModule = typeof import('@earendil-works/pi-coding-agent');
type GenerateSummaryArguments = Parameters<PiCodingAgentModule['generateSummary']>;

interface CheckpointWorkerInput {
  piModuleUrl: string;
  messages: GenerateSummaryArguments[0];
  model: GenerateSummaryArguments[1];
  reserveTokens: GenerateSummaryArguments[2];
  apiKey?: GenerateSummaryArguments[3];
  headers?: GenerateSummaryArguments[4];
  instructions: GenerateSummaryArguments[6];
  previousCheckpoint?: GenerateSummaryArguments[7];
  thinkingLevel?: GenerateSummaryArguments[8];
  env?: GenerateSummaryArguments[10];
}

export async function generateCheckpointInWorker(input: CheckpointWorkerInput): Promise<string> {
  const { generateSummary } = (await import(input.piModuleUrl)) as PiCodingAgentModule;
  return generateSummary(
    input.messages,
    input.model,
    input.reserveTokens,
    input.apiKey,
    input.headers,
    undefined,
    input.instructions,
    input.previousCheckpoint,
    input.thinkingLevel,
    undefined,
    input.env,
  );
}

async function summarize(input: CheckpointWorkerInput): Promise<void> {
  try {
    const checkpoint = await generateCheckpointInWorker(input);
    parentPort?.postMessage({ checkpoint });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) void summarize(workerData as CheckpointWorkerInput);
