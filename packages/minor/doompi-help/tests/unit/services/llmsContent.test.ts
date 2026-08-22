import { describe, expect, it } from 'vitest';
import { MAX_LLMS_BYTES, renderHelpSkillWrapper, validateLlmsBytes } from '../../../src/services/llmsContent.ts';
import type { ResolvedHelpIndex } from '../../../src/types/help.ts';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function index(): ResolvedHelpIndex {
  return {
    identity: {
      source: '@agimon-ai/example',
      version: '1.2.3',
      packageRoot: '/packages/example',
      modulePath: '/packages/example/dist/extension.mjs',
    },
    location: 'local',
    filePath: '/packages/example/llms.txt',
    referenceBase: '/packages/example',
    byteLength: 16,
    digest: 'digest',
  };
}

describe('llms.txt content validation', () => {
  it('accepts a BOM, blank lines, safe relative links, fragments, and web links', () => {
    const text =
      '\uFEFF\n# Example Help\n\n- [Guide](./docs/guide.md#start)\n- [Reference][guide]\n- [Site](https://example.com/docs)\n\n[guide]: docs/reference.md\n';

    expect(validateLlmsBytes(encode(text))).toBe(text.slice(1));
  });

  it.each([
    ['', 'empty'],
    ['plain text', 'Markdown H1'],
    ['# Help\n\0', 'control'],
    ['# Help\n[Escape](../secret.md)', 'escapes'],
    ['# Help\n[Encoded](%2e%2e/secret.md)', 'escapes'],
    ['# Help\n[Double encoded](%252e%252e/secret.md)', 'escapes'],
    ['# Help\n[Reference][guide]\n\n[guide]: ../secret.md', 'escapes'],
    ['# Help\n<a href="../secret.md">Escape</a>', 'escapes'],
    ['# Help\n<../secret.md>', 'escapes'],
    ['# Help\n[Absolute](/secret.md)', 'escapes'],
    ['# Help\n[File](file:///tmp/secret)', 'unsupported link scheme'],
    ['# Help\n[Encoded file](file%3A///tmp/secret)', 'unsupported link scheme'],
    ['# Help\n[Bad](%EA%A4%A)', 'invalid encoded link'],
  ])('rejects invalid content %#', (text, message) => {
    expect(() => validateLlmsBytes(encode(text))).toThrowError(message);
  });

  it('rejects invalid UTF-8 and oversized indexes', () => {
    expect(() => validateLlmsBytes(Uint8Array.from([0xc3, 0x28]))).toThrowError('valid UTF-8');
    expect(() => validateLlmsBytes(new Uint8Array(MAX_LLMS_BYTES + 1))).toThrowError('exceeds');
  });

  it('renders a valid generated SKILL.md wrapper with escaped frontmatter', () => {
    const wrapper = renderHelpSkillWrapper({ name: 'example-help', description: 'Use: "carefully"' }, index());

    expect(wrapper).toContain('name: "example-help"');
    expect(wrapper).toContain('description: "Use: \\"carefully\\""');
    expect(wrapper).toContain('"/packages/example/llms.txt"');
    expect(wrapper).toContain('"/packages/example"');
    expect(wrapper).toContain('do not recursively load');
  });
});
