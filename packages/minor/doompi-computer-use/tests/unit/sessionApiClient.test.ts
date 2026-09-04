import { describe, expect, it } from 'vitest';
import {
  createComputerUseSessionClient,
  UnixComputerUseSessionClient,
} from '../../src/adapters/pi/sessionApiClient.ts';

describe('computer-use session API client discovery', () => {
  it('fails closed unless both host-issued connection values exist', () => {
    expect(createComputerUseSessionClient({})).toBeUndefined();
    expect(createComputerUseSessionClient({ DOOMPI_SESSION_API_SOCKET: '/tmp/session.sock' })).toBeUndefined();
    expect(createComputerUseSessionClient({ DOOMPI_SESSION_API_INTERNAL_TOKEN: 'token' })).toBeUndefined();
  });

  it('creates the Unix-socket client only from complete host configuration', () => {
    expect(
      createComputerUseSessionClient({
        DOOMPI_SESSION_API_SOCKET: '/tmp/session.sock',
        DOOMPI_SESSION_API_INTERNAL_TOKEN: 'token',
      }),
    ).toBeInstanceOf(UnixComputerUseSessionClient);
  });

  it('propagates Unix socket connection failures for every operation', async () => {
    const client = new UnixComputerUseSessionClient({
      socketPath: `/tmp/doompi-computer-use-missing-${process.pid}.sock`,
      token: 'token',
    });

    await expect(client.state()).rejects.toThrow();
    await expect(client.observe()).rejects.toThrow();
    await expect(client.act({ kind: 'press', snapshotId: 'snapshot-1', elementRef: 'button-1' })).rejects.toThrow();
    await expect(client.stop()).rejects.toThrow();
  });
});
