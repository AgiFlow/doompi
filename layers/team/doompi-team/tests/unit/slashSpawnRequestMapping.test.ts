import { describe, expect, it } from 'vitest';

import {
  assertSupportedInlineConfig,
  taskInputFromParsedStep,
  UnsupportedInlineConfigError,
} from '../../src/adapters/pi/commands/slash/spawnRequestMapping';

describe('assertSupportedInlineConfig', () => {
  it('does not throw for a config with only currently-supported keys set', () => {
    expect(() => assertSupportedInlineConfig({ model: 'sonnet', cwd: '/work', as: 'step1' }, 'worker')).not.toThrow();
  });

  it('does not throw for an empty config', () => {
    expect(() => assertSupportedInlineConfig({}, 'worker')).not.toThrow();
  });

  it.each(['output', 'outputMode', 'reads', 'skill', 'progress', 'count', 'outputSchema', 'acceptance'] as const)(
    'throws UnsupportedInlineConfigError naming "%s" when the user sets it',
    (key) => {
      const value = key === 'progress' ? true : key === 'count' ? 1 : 'x';
      const config = { [key]: value };
      expect(() => assertSupportedInlineConfig(config, 'worker')).toThrow(UnsupportedInlineConfigError);
      try {
        assertSupportedInlineConfig(config, 'worker');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedInlineConfigError);
        expect((error as UnsupportedInlineConfigError).key).toBe(key);
        expect((error as UnsupportedInlineConfigError).message).toContain('worker');
        expect((error as UnsupportedInlineConfigError).message).toContain('not supported yet');
      }
    },
  );

  it('names the FIRST not-yet-supported key when several are set, deterministically', () => {
    expect(() => assertSupportedInlineConfig({ acceptance: 'checked', output: 'file.md' }, 'worker')).toThrow(
      /'output'/,
    );
  });
});

describe('taskInputFromParsedStep', () => {
  it('builds a minimal SpawnPlanTaskInput from a bare step', () => {
    const input = taskInputFromParsedStep({ name: 'worker', config: {}, task: 'do it' }, '/work');
    expect(input).toEqual({ agent: 'worker', task: 'do it', cwd: '/work' });
  });

  it('prefers the step-level cwd override over the fallback cwd', () => {
    const input = taskInputFromParsedStep({ name: 'worker', config: { cwd: '/step-cwd' }, task: 'x' }, '/work');
    expect(input.cwd).toBe('/step-cwd');
  });

  it('includes model when set', () => {
    const input = taskInputFromParsedStep({ name: 'worker', config: { model: 'sonnet' }, task: 'x' }, '/work');
    expect(input.model).toBe('sonnet');
  });

  it('includes context when given', () => {
    const input = taskInputFromParsedStep({ name: 'worker', config: {}, task: 'x' }, '/work', 'fork');
    expect(input.context).toBe('fork');
  });

  it('omits task when the step has none', () => {
    const input = taskInputFromParsedStep({ name: 'worker', config: {}, task: undefined }, '/work');
    expect(input).not.toHaveProperty('task');
  });

  it('throws before building anything when a not-yet-supported key is set', () => {
    expect(() => taskInputFromParsedStep({ name: 'worker', config: { skill: ['x'] }, task: 'x' }, '/work')).toThrow(
      UnsupportedInlineConfigError,
    );
  });
});
