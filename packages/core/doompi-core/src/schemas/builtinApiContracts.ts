import { PROTOCOL_VERSION } from '@earendil-works/pi-protocol';

import { defineApiContract } from './apiContracts';
import { headlessHttpContracts, machineHttpContracts, sessionHttpContracts } from './httpApiContracts';
import {
  SealedEnvelopeSchema,
  SealedHttpRequestSchema,
  SealedHttpResponseSchema,
  remoteHttpContracts,
  bundleHttpContracts,
} from './remoteApiContracts';
import { sessionSocketContracts } from './sessionApiContracts';
import { transportSocketContracts } from './transportApiContracts';

export const builtinApiContract = defineApiContract({
  version: 1,
  schemas: {
    SealedEnvelope: SealedEnvelopeSchema,
    SealedHttpRequest: SealedHttpRequestSchema,
    SealedHttpResponse: SealedHttpResponseSchema,
  },
  protocols: { pi: String(PROTOCOL_VERSION), chord: '0.85.1', sealed: '1' },
  http: [
    ...headlessHttpContracts,
    ...machineHttpContracts,
    ...sessionHttpContracts,
    ...remoteHttpContracts,
    ...bundleHttpContracts,
  ],
  sockets: [...sessionSocketContracts, ...transportSocketContracts],
  dynamic: [
    'WebAuthn options and credential responses follow the installed WebAuthn implementation.',
    'Tool inputs/results and journal entries contain runtime-defined JSON.',
    'Selected channel and presentation payload schemas are contributed by their owning package.',
  ],
});
