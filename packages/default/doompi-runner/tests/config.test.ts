import { describe, expect, it } from 'vitest';
import {
  BG_THRESHOLD_MS_ENV,
  DEFAULT_BG_THRESHOLD_MS,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_TTL_MS,
  DEFAULT_RESULT_MAX_BYTES,
  getBackgroundThresholdMs,
  getLogMaxBytes,
  getLogTtlMs,
  getResultMaxBytes,
  LOG_MAX_BYTES_ENV,
  LOG_TTL_MS_ENV,
  RESULT_MAX_BYTES_ENV,
} from '../src/exports/config';

const cases = [
  {
    name: 'background threshold',
    read: getBackgroundThresholdMs,
    env: BG_THRESHOLD_MS_ENV,
    fallback: DEFAULT_BG_THRESHOLD_MS,
  },
  { name: 'result ceiling', read: getResultMaxBytes, env: RESULT_MAX_BYTES_ENV, fallback: DEFAULT_RESULT_MAX_BYTES },
  { name: 'log ceiling', read: getLogMaxBytes, env: LOG_MAX_BYTES_ENV, fallback: DEFAULT_LOG_MAX_BYTES },
  { name: 'log retention', read: getLogTtlMs, env: LOG_TTL_MS_ENV, fallback: DEFAULT_LOG_TTL_MS },
];

describe.each(cases)('$name', ({ read, env, fallback }) => {
  it('falls back when unset', () => {
    expect(read({})).toBe(fallback);
  });

  it('reads a positive override', () => {
    expect(read({ [env]: '1234' })).toBe(1234);
  });

  it.each(['', '0', '-1', 'soon'])('falls back on the unusable value %j', (value) => {
    expect(read({ [env]: value })).toBe(fallback);
  });
});
