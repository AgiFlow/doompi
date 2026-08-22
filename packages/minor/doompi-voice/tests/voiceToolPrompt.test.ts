import type {
  VoiceToolBatchResult,
  VoiceToolCatalogEntry,
  VoiceToolCatalogSnapshot,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { describe, expect, it } from 'vitest';
import { formatBatch, formatCatalog, formatError } from '../src/services/voiceToolPrompt.ts';

const TOKEN = 'voice-test:voice-session:2:9';

function entry(overrides: Partial<VoiceToolCatalogEntry> = {}): VoiceToolCatalogEntry {
  return {
    source: '@agimon-ai/doompi-voice',
    id: 'list-domains',
    name: 'list_domains',
    label: 'List domains',
    description: 'List active, effective, and available Doom domains.',
    order: 100,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    enabled: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<VoiceToolCatalogSnapshot> = {}): VoiceToolCatalogSnapshot {
  return {
    hostGeneration: 'voice-test:voice-session:2',
    catalogRevision: 9,
    catalogToken: TOKEN,
    tools: [entry()],
    conflicts: [],
    unknownNames: [],
    ...overrides,
  };
}

function batch(overrides: Partial<VoiceToolBatchResult> = {}): VoiceToolBatchResult {
  return { status: 'completed', catalogToken: TOKEN, results: [], ...overrides };
}

describe('voice catalog prompt block', () => {
  it('carries the catalog token the model has to echo back', () => {
    const text = formatCatalog(snapshot(), false);
    expect(text).toContain(`<catalog_token>${TOKEN}</catalog_token>`);
    expect(text.startsWith('<voice_tool_catalog>')).toBe(true);
    expect(text.endsWith('</voice_tool_catalog>')).toBe(true);
  });

  it('lists names and descriptions only until capabilities are named', () => {
    const bare = formatCatalog(snapshot(), false);
    expect(bare).toContain(
      '<capability name="list_domains" enabled="true">List active, effective, and available Doom domains.</capability>',
    );
    expect(bare).not.toContain('<input_schema>');
    expect(bare).toContain('<usage>Call describe_voice_tools with names');

    const detailed = formatCatalog(snapshot(), true);
    expect(detailed).toContain('<label>List domains</label>');
    expect(detailed).toContain('<source>@agimon-ai/doompi-voice</source>');
    expect(detailed).toContain('<input_schema>{"type":"object","properties":{},"additionalProperties":false}');
    expect(detailed).toContain('<usage>Pass this exact catalog_token');
  });

  it('leaves quotes inside a serialized schema readable', () => {
    // Quote escaping belongs to attributes; entity-encoding JSON would make the schema
    // unreadable to the model, which is the whole reason it is emitted.
    expect(formatCatalog(snapshot(), true)).not.toContain('&quot;');
  });

  it('escapes markup in descriptions and attributes', () => {
    const text = formatCatalog(
      snapshot({
        tools: [entry({ description: 'Compare <a> & <b>' })],
        conflicts: [{ name: 'say "hi"', message: 'Conflicting <registrations>', claims: [] as never }],
      }),
      false,
    );
    expect(text).toContain('Compare &lt;a&gt; &amp; &lt;b&gt;');
    expect(text).toContain('<conflict name="say &quot;hi&quot;">Conflicting &lt;registrations&gt;</conflict>');
  });

  it('reports an empty catalog, disabled capabilities, and unknown names', () => {
    const empty = formatCatalog(snapshot({ tools: [] }), false);
    expect(empty).toContain('<capabilities_empty/>');
    expect(empty).toContain('<usage>No voice capabilities are registered for this session.</usage>');

    const disabled = formatCatalog(
      snapshot({ tools: [entry({ enabled: false })], unknownNames: ['staging_switch'] }),
      false,
    );
    expect(disabled).toContain('enabled="false"');
    expect(disabled).toContain('<usage>Disabled capabilities cannot run until autonomous voice is active.</usage>');
    expect(disabled).toContain('<unknown_name>staging_switch</unknown_name>');
  });

  it('drops whole capabilities and says so rather than truncating one mid element', () => {
    const wide = { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(2_000) } } };
    const tools = Array.from({ length: 8 }, (_, index) =>
      entry({ id: `wide-${index}`, name: `wide_${index}`, inputSchema: wide }),
    );
    const text = formatCatalog(snapshot({ tools }), true);
    expect(text).toMatch(/<truncated capabilities="\d+">/);
    expect(text).toContain('</voice_tool_catalog>');
    expect(text).toContain(`<catalog_token>${TOKEN}</catalog_token>`);
    // Every capability that survived is a complete element.
    expect(text.match(/<capability /g)?.length).toBe(text.match(/<\/capability>/g)?.length);
  });
});

describe('voice batch prompt block', () => {
  it('returns each capability result, which details alone never showed the model', () => {
    const text = formatBatch(
      batch({
        results: [
          { index: 0, name: 'list_domains', status: 'completed', result: { active: ['core'], available: ['blend'] } },
        ],
      }),
    );
    expect(text).toContain('<voice_tool_batch status="completed">');
    expect(text).toContain('<result>{"active":["core"],"available":["blend"]}</result>');
  });

  it('returns a fresh token with a stale rejection so the batch can be retried directly', () => {
    const text = formatBatch(
      batch({
        status: 'rejected',
        catalogToken: 'voice-test:voice-session:2:10',
        errors: [{ code: 'VOICE_TOOL_STALE_CATALOG', message: 'The voice tool catalog is stale.', retryable: true }],
        results: [{ index: 0, name: 'list_domains', status: 'not_executed' }],
      }),
    );
    expect(text).toContain('<catalog_token>voice-test:voice-session:2:10</catalog_token>');
    expect(text).toContain(
      '<error code="VOICE_TOOL_STALE_CATALOG" retryable="true">The voice tool catalog is stale.</error>',
    );
    expect(text).toContain('<call index="0" name="list_domains" status="not_executed"/>');
  });

  it('reports per-call failures and cancellations', () => {
    const text = formatBatch(
      batch({
        status: 'cancelled',
        results: [
          {
            index: 0,
            name: 'switch_domains',
            status: 'preflight_failed',
            error: { code: 'VOICE_TOOL_INVALID_INPUT', message: 'Voice tool input is invalid.' },
          },
          { index: 1, name: 'list_domains', status: 'cancelled' },
        ],
      }),
    );
    expect(text).toContain('<voice_tool_batch status="cancelled">');
    expect(text).toContain('<call index="0" name="switch_domains" status="preflight_failed">');
    expect(text).toContain('<error code="VOICE_TOOL_INVALID_INPUT" retryable="false">');
    expect(text).toContain('<call index="1" name="list_domains" status="cancelled"/>');
  });
});

describe('voice façade error block', () => {
  it('states the code and whether retrying is worthwhile', () => {
    expect(
      formatError({
        code: 'VOICE_TOOL_HOST_UNAVAILABLE',
        message: 'Autonomous voice is not bound to an active Pi session.',
        retryable: true,
      }),
    ).toBe(
      '<voice_tool_error code="VOICE_TOOL_HOST_UNAVAILABLE" retryable="true">Autonomous voice is not bound to an active Pi session.</voice_tool_error>',
    );
    expect(
      formatError({ code: 'VOICE_TOOL_EXECUTION_FAILED', message: 'Voice tool façade execution failed.' }),
    ).toContain('retryable="false"');
  });
});
