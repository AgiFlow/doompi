import fs from 'node:fs';
import path from 'node:path';

import { encodePcm16Wav, PCM_BYTES_PER_SAMPLE } from '../../services/pcm.ts';
import type { ITurnSpool, TurnSnapshot, TurnSpoolIdentity, TurnSpoolManifest } from '../../services/turnSpool.ts';

const MANIFEST_VERSION = 1 as const;
const MANIFEST_FILE = 'manifest.json';
const PCM_FILE = 'turn.pcm';
const SNAPSHOT_DIRECTORY = 'snapshots';

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error(`Invalid voice spool ${label}.`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Voice spool manifest ${label} must be a non-negative integer.`);
  return value;
}

function parseManifest(value: unknown): TurnSpoolManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Voice spool manifest must be an object.');
  const record = value as Record<string, unknown>;
  if (record.version !== MANIFEST_VERSION) throw new Error('Unsupported voice spool manifest version.');
  for (const key of ['sessionId', 'captureId', 'turnId'] as const) {
    if (typeof record[key] !== 'string') throw new Error(`Voice spool manifest ${key} must be a string.`);
    assertIdentifier(record[key], key);
  }
  const committedBytes = nonNegativeInteger(record.committedBytes, 'committedBytes');
  if (committedBytes % PCM_BYTES_PER_SAMPLE !== 0)
    throw new Error('Voice spool committed length must contain complete samples.');
  const utteranceStartByte =
    record.utteranceStartByte === undefined
      ? undefined
      : nonNegativeInteger(record.utteranceStartByte, 'utteranceStartByte');
  if (utteranceStartByte !== undefined) {
    if (utteranceStartByte % PCM_BYTES_PER_SAMPLE !== 0)
      throw new Error('Voice spool utterance start must contain complete samples.');
    if (utteranceStartByte > committedBytes) throw new Error('Voice spool utterance start exceeds committed length.');
  }
  const captureGeneration = nonNegativeInteger(record.captureGeneration, 'captureGeneration');
  const revision = nonNegativeInteger(record.revision, 'revision');
  const gapCount = nonNegativeInteger(record.gapCount, 'gapCount');
  const acknowledgedRevision = record.acknowledgedRevision;
  if (acknowledgedRevision !== undefined) nonNegativeInteger(acknowledgedRevision, 'acknowledgedRevision');
  const acknowledgedOutcome = record.acknowledgedOutcome;
  if (acknowledgedOutcome !== undefined && acknowledgedOutcome !== 'committed' && acknowledgedOutcome !== 'discarded')
    throw new Error('Voice spool acknowledged outcome is invalid.');
  return {
    version: MANIFEST_VERSION,
    sessionId: record.sessionId as string,
    captureId: record.captureId as string,
    turnId: record.turnId as string,
    committedBytes,
    ...(utteranceStartByte === undefined ? {} : { utteranceStartByte }),
    captureGeneration,
    revision,
    gapCount,
    ...(acknowledgedRevision === undefined ? {} : { acknowledgedRevision: acknowledgedRevision as number }),
    ...(acknowledgedOutcome === undefined ? {} : { acknowledgedOutcome }),
  };
}

function writePrivateFile(filePath: string, contents: string | Buffer): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export class NodeTurnSpool implements ITurnSpool {
  public readonly directory: string;
  private readonly pcmPath: string;
  private readonly manifestPath: string;
  private manifest: TurnSpoolManifest;
  private closed = false;

  private constructor(directory: string, manifest: TurnSpoolManifest) {
    this.directory = directory;
    this.pcmPath = path.join(directory, PCM_FILE);
    this.manifestPath = path.join(directory, MANIFEST_FILE);
    this.manifest = manifest;
  }

  public static create(rootDirectory: string, identity: TurnSpoolIdentity): NodeTurnSpool {
    assertIdentifier(identity.sessionId, 'sessionId');
    assertIdentifier(identity.captureId, 'captureId');
    assertIdentifier(identity.turnId, 'turnId');
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(rootDirectory, 0o700);
    const directory = fs.mkdtempSync(path.join(rootDirectory, 'turn-'));
    fs.chmodSync(directory, 0o700);
    fs.mkdirSync(path.join(directory, SNAPSHOT_DIRECTORY), { mode: 0o700 });
    writePrivateFile(path.join(directory, PCM_FILE), Buffer.alloc(0));
    const spool = new NodeTurnSpool(directory, {
      version: MANIFEST_VERSION,
      ...identity,
      committedBytes: 0,
      captureGeneration: 0,
      revision: 0,
      gapCount: 0,
    });
    spool.publishManifest();
    return spool;
  }

  public static recover(directory: string): NodeTurnSpool {
    const manifest = parseManifest(JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_FILE), 'utf8')));
    const pcmPath = path.join(directory, PCM_FILE);
    const availableBytes = fs.statSync(pcmPath).size;
    if (availableBytes < manifest.committedBytes)
      throw new Error('Voice spool PCM is shorter than its committed length.');
    if (availableBytes !== manifest.committedBytes) fs.truncateSync(pcmPath, manifest.committedBytes);
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(pcmPath, 0o600);
    return new NodeTurnSpool(directory, manifest);
  }

  public snapshotManifest(): TurnSpoolManifest {
    return { ...this.manifest };
  }

  public setCaptureGeneration(generation: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(generation) || generation < this.manifest.captureGeneration)
      throw new Error('Voice spool capture generation must be monotonic.');
    this.manifest.captureGeneration = generation;
    this.publishManifest();
  }

  public markUtteranceStart(byteOffset: number): void {
    this.assertOpen();
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0)
      throw new Error('Voice spool utterance start must be a non-negative integer.');
    if (byteOffset % PCM_BYTES_PER_SAMPLE !== 0)
      throw new Error('Voice spool utterance start must contain complete samples.');
    if (byteOffset > this.manifest.committedBytes)
      throw new Error('Voice spool utterance start exceeds committed length.');
    if (this.manifest.utteranceStartByte !== undefined) {
      if (this.manifest.utteranceStartByte !== byteOffset)
        throw new Error('Voice spool utterance start is already set.');
      return;
    }
    this.manifest.utteranceStartByte = byteOffset;
    this.publishManifest();
  }

  public append(pcm: Buffer): void {
    this.assertOpen();
    if (pcm.length === 0) return;
    if (pcm.length % PCM_BYTES_PER_SAMPLE !== 0)
      throw new Error('Voice spool PCM must contain complete 16-bit samples.');
    const descriptor = fs.openSync(this.pcmPath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, pcm);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.manifest.committedBytes += pcm.length;
    this.publishManifest();
  }

  public recordGap(): void {
    this.assertOpen();
    this.manifest.gapCount += 1;
    this.publishManifest();
  }

  public createSnapshot(): TurnSnapshot {
    this.assertOpen();
    this.manifest.revision += 1;
    const pcm = this.readCommittedPcm();
    const utterancePcm = pcm.subarray(this.manifest.utteranceStartByte ?? 0);
    const wavPath = path.join(this.directory, SNAPSHOT_DIRECTORY, `revision-${this.manifest.revision}.wav`);
    writePrivateFile(wavPath, encodePcm16Wav(utterancePcm));
    this.publishManifest();
    return { revision: this.manifest.revision, wavPath, pcmBytes: utterancePcm.length };
  }

  public acknowledge(revision: number, outcome: 'committed' | 'discarded'): void {
    this.assertOpen();
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision > this.manifest.revision)
      throw new Error('Voice spool acknowledgement revision is invalid.');
    if (this.manifest.acknowledgedRevision !== undefined && revision < this.manifest.acknowledgedRevision)
      throw new Error('Voice spool acknowledgement must be monotonic.');
    this.manifest.acknowledgedRevision = revision;
    this.manifest.acknowledgedOutcome = outcome;
    this.publishManifest();
  }

  public readCommittedPcm(): Buffer {
    this.assertOpen();
    const pcm = fs.readFileSync(this.pcmPath);
    if (pcm.length < this.manifest.committedBytes) throw new Error('Voice spool PCM lost committed bytes.');
    return pcm.subarray(0, this.manifest.committedBytes);
  }

  public close(): void {
    this.closed = true;
  }

  public remove(): void {
    this.closed = true;
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Voice spool is closed.');
  }

  private publishManifest(): void {
    const temporaryPath = `${this.manifestPath}.tmp`;
    writePrivateFile(temporaryPath, `${JSON.stringify(this.manifest)}\n`);
    fs.renameSync(temporaryPath, this.manifestPath);
    fs.chmodSync(this.manifestPath, 0o600);
  }
}
