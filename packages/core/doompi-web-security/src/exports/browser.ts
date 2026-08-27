export {
  type OpenResult,
  type SealResult,
  type SealedChannel,
  channelFromSecret,
  connectSealedChannel,
} from '../adapters/browserSealedChannel.ts';
export { type SealedTransport, createSealedTransport, sealedTransport } from '../adapters/sealedTransport.ts';
