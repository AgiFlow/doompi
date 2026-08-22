/**
 * Structured output: the schema a step must satisfy, and the file it answers in.
 *
 * A step with an `outputSchema` may not finish in prose. The runtime hands the
 * child a `structured_output` tool whose parameters are derived from the schema,
 * writes the schema to a private temp directory, and validates whatever the child
 * wrote back before the run is allowed to succeed.
 *
 * DESIGN PATTERNS:
 * - The author's schema is nested under a `value` property rather than used as
 *   the tool parameters directly, because a tool's parameters must be an object
 *   and an author is entitled to declare a top-level array or string
 * - Local JSON pointers are rewritten during that nesting. `#/$defs/x` addressed
 *   the author's schema root, which is now one level down, so an unrewritten
 *   pointer would resolve against the wrapper and silently validate nothing
 * - Every failure is returned as a message, never thrown. An invalid schema is an
 *   authoring mistake to report against the run, not a crash of the parent
 *
 * PERFORMANCE:
 * `typebox/compile` is loaded once per process and memoised. It is a heavy
 * import and every validated step would otherwise pay for it. A failed load
 * clears the memo so a transient resolution failure is retried rather than
 * cached forever.
 *
 * AVOID:
 * - Joining `os.tmpdir()` here; the temp root belongs to `shared/paths.ts`
 * - Treating an absent output file as a validation failure. It means the child
 *   never called the tool, which is a different diagnosis for the operator
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from '../../../types/environment';
import { TEMP_ROOT_DIR } from '../../filesystem/paths';
import type { JsonSchemaObject } from '../../../types';

export { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from '../../../types/environment';

export const MISSING_STRUCTURED_OUTPUT_CALL_ERROR =
  'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.';

/** Where the schema and the child's answer live for one run. */
export interface StructuredOutputRuntime {
  schema: JsonSchemaObject;
  schemaPath: string;
  outputPath: string;
}

// ============================================================================
// Wrapping an authored schema as tool parameters
// ============================================================================

/** The property the author's schema is nested under inside the tool parameters. */
const STRUCTURED_OUTPUT_VALUE_PROPERTY = 'value';
/** JSON pointer that addresses the nested schema from the wrapper root. */
const STRUCTURED_OUTPUT_VALUE_POINTER = `#/properties/${STRUCTURED_OUTPUT_VALUE_PROPERTY}`;

/** Keywords whose value is a map of names to subschemas. */
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;
/** Keywords whose value is a single subschema. */
const SCHEMA_SINGLE_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'not',
  'propertyNames',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
] as const;
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** Reference keywords that can carry a local pointer needing a rebase. */
const SCHEMA_REF_KEYWORDS = ['$ref', '$dynamicRef', '$recursiveRef'] as const;

/** A pointer to the schema resource root, which moves when the schema is nested. */
const ROOT_POINTER = '#';
const LOCAL_POINTER_PREFIX = '#/';

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebase local JSON pointers so they still address the author's schema once it
 * has been nested under the wrapper.
 *
 * `$id` stops the descent: a subschema declaring one starts a new resource, so
 * its local pointers address itself and were never relative to the wrapper.
 * Boolean schemas (`true`/`false`) are legal JSON Schema and pass through.
 */
function rewriteLocalJsonPointerRefs(schema: unknown, pointerPrefix: string, inheritsWrapperResource = true): unknown {
  if (typeof schema === 'boolean' || !isSchemaRecord(schema)) return schema;
  const source = schema;
  const rewritten: Record<string, unknown> = { ...source };
  const sharesWrapperResource = inheritsWrapperResource && typeof source.$id !== 'string';
  if (sharesWrapperResource) {
    for (const keyword of SCHEMA_REF_KEYWORDS) {
      const ref = source[keyword];
      if (ref === ROOT_POINTER) rewritten[keyword] = pointerPrefix;
      else if (typeof ref === 'string' && ref.startsWith(LOCAL_POINTER_PREFIX)) {
        rewritten[keyword] = `${pointerPrefix}${ref.slice(ROOT_POINTER.length)}`;
      }
    }
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const entries = source[keyword];
    if (!isSchemaRecord(entries)) continue;
    rewritten[keyword] = Object.fromEntries(
      Object.entries(entries).map(([name, nested]) => [
        name,
        rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
      ]),
    );
  }
  const items = source.items;
  if (Array.isArray(items)) {
    rewritten.items = items.map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
  } else if (items !== undefined) {
    rewritten.items = rewriteLocalJsonPointerRefs(items, pointerPrefix, sharesWrapperResource);
  }
  for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
    if (source[keyword] !== undefined) {
      rewritten[keyword] = rewriteLocalJsonPointerRefs(source[keyword], pointerPrefix, sharesWrapperResource);
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const branches = source[keyword];
    if (Array.isArray(branches)) {
      rewritten[keyword] = branches.map((nested) =>
        rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
      );
    }
  }
  const dependencies = source.dependencies;
  if (isSchemaRecord(dependencies)) {
    // Draft-07 `dependencies` is either a property-name list or a subschema.
    rewritten.dependencies = Object.fromEntries(
      Object.entries(dependencies).map(([name, nested]) => [
        name,
        Array.isArray(nested) ? nested : rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
      ]),
    );
  }
  return rewritten;
}

/** Parameters for the `structured_output` tool that satisfies `schema`. */
export function createStructuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      [STRUCTURED_OUTPUT_VALUE_PROPERTY]: rewriteLocalJsonPointerRefs(schema, STRUCTURED_OUTPUT_VALUE_POINTER),
    },
    required: [STRUCTURED_OUTPUT_VALUE_PROPERTY],
    additionalProperties: false,
  };
}

// ============================================================================
// Runtime files
// ============================================================================

const STRUCTURED_OUTPUT_DIR_PREFIX = 'doom-team-structured-';
const SCHEMA_FILE_NAME = 'schema.json';
const OUTPUT_FILE_NAME = 'output.json';
/** The schema can carry task detail, so it is readable only by its own user. */
const PRIVATE_FILE_MODE = 0o600;

export function assertJsonSchemaObject(schema: unknown, label = 'outputSchema'): asserts schema is JsonSchemaObject {
  if (!isSchemaRecord(schema)) {
    throw new Error(`${label} must be a JSON Schema object.`);
  }
}

/** Stage the schema on disk and reserve the path the child answers in. */
export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
  assertJsonSchemaObject(schema);
  const rootDir = baseDir ?? TEMP_ROOT_DIR;
  fs.mkdirSync(rootDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(rootDir, STRUCTURED_OUTPUT_DIR_PREFIX));
  const schemaPath = path.join(dir, SCHEMA_FILE_NAME);
  const outputPath = path.join(dir, OUTPUT_FILE_NAME);
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: PRIVATE_FILE_MODE });
  return { schema, schemaPath, outputPath };
}

/**
 * Remove the run's schema and output directory.
 *
 * The failure is returned rather than thrown or logged: the directory is under
 * the per-user temp root, so a leftover is harmless and must not fail a run that
 * has already produced its result. Returning it still lets a caller that cares,
 * such as a teardown check, see what happened instead of it vanishing.
 */
export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): {
  removed: boolean;
  error?: string;
} {
  if (!runtime) return { removed: false };
  try {
    fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return { removed: false, error: toMessage(error) };
  }
}

// ============================================================================
// Validation
// ============================================================================

/** The compiled-validator surface this module uses out of `typebox/compile`. */
interface CompiledJsonSchema {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type CompileJsonSchema = (schema: unknown) => CompiledJsonSchema;

const TYPEBOX_COMPILE_SPECIFIER = 'typebox/compile';
const COMPILE_EXPORT_NAME = 'Compile';
/** How many schema violations are reported before the message is truncated. */
const MAX_REPORTED_SCHEMA_ERRORS = 8;
/** Path shown for a violation at the document root. */
const ROOT_INSTANCE_PATH_LABEL = 'root';

export type StructuredOutputValidation = { status: 'valid' } | { status: 'invalid'; message: string };

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCompileExport(mod: unknown): CompileJsonSchema | undefined {
  if (!isSchemaRecord(mod)) return undefined;
  const compile = mod[COMPILE_EXPORT_NAME];
  return typeof compile === 'function' ? (compile as CompileJsonSchema) : undefined;
}

/**
 * Load `typebox/compile` out of the host Pi installation.
 *
 * Exported because the host package root is the only place the dependency is
 * guaranteed to resolve when this extension is loaded from outside the host's
 * own `node_modules` tree.
 */
export async function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
  const requireFromRoot = createRequire(path.join(packageRoot, 'package.json'));
  const resolved = requireFromRoot.resolve(TYPEBOX_COMPILE_SPECIFIER);
  const mod: unknown = await import(pathToFileURL(resolved).href);
  return readCompileExport(mod);
}

/**
 * Validates structured output against an authored JSON Schema.
 *
 * WHY THIS IS A SERVICE AND NOT A FUNCTION:
 * The compiler import is memoised for the life of the process, and that memo is
 * mutable state that needs an owner. As a module-level variable it also could
 * not be reset between tests, which made a single failed-load test poison every
 * later one.
 */
export class StructuredOutputValidator {
  private cachedCompile: Promise<CompileJsonSchema> | undefined;

  /** Import seam: ESM namespaces are frozen, so a test cannot spy on the import. */
  protected importCompileModule(): Promise<unknown> {
    return import(TYPEBOX_COMPILE_SPECIFIER);
  }

  /** Import seam for the host-package-root fallback. */
  protected importCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
    return resolveCompileFromPackageRoot(packageRoot);
  }

  /**
   * Resolve the compiler, reporting every attempt that failed.
   *
   * Both routes are named in the error because which one failed is what tells
   * an operator whether the extension is mis-installed or the host env is unset.
   */
  private async importCompile(): Promise<CompileJsonSchema> {
    const failures: string[] = [];
    try {
      const compile = readCompileExport(await this.importCompileModule());
      if (compile) return compile;
      failures.push(`${TYPEBOX_COMPILE_SPECIFIER} did not export a ${COMPILE_EXPORT_NAME} function`);
    } catch (error) {
      failures.push(`direct import failed: ${toMessage(error)}`);
    }
    const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
    if (packageRoot) {
      try {
        const compile = await this.importCompileFromPackageRoot(packageRoot);
        if (compile) return compile;
        failures.push(`Pi package root ${TYPEBOX_COMPILE_SPECIFIER} did not export a ${COMPILE_EXPORT_NAME} function`);
      } catch (error) {
        failures.push(`Pi package root import failed: ${toMessage(error)}`);
      }
    } else {
      failures.push(`${PI_CODING_AGENT_PACKAGE_ROOT_ENV} is not set`);
    }
    throw new Error(
      `Cannot load ${TYPEBOX_COMPILE_SPECIFIER} for structured output validation (${failures.join('; ')})`,
    );
  }

  /** Memoised compiler. A rejected load drops the memo so it can be retried. */
  private loadCompile(): Promise<CompileJsonSchema> {
    if (!this.cachedCompile) {
      this.cachedCompile = this.importCompile().catch((error: unknown) => {
        this.cachedCompile = undefined;
        throw error;
      });
    }
    return this.cachedCompile;
  }

  /** Drop the memoised compiler. Intended for tests and teardown. */
  reset(): void {
    this.cachedCompile = undefined;
  }

  async validateValue(schema: JsonSchemaObject, value: unknown): Promise<StructuredOutputValidation> {
    const compile = await this.loadCompile();
    let validator: CompiledJsonSchema;
    try {
      validator = compile(schema);
    } catch (error) {
      // A schema that will not compile is the author's mistake, not a runtime
      // fault, so it is reported against the run like any other invalid output.
      return { status: 'invalid', message: `invalid outputSchema: ${toMessage(error)}` };
    }
    if (validator.Check(value)) return { status: 'valid' };
    const errors = [...validator.Errors(value)].slice(0, MAX_REPORTED_SCHEMA_ERRORS).map((error) => {
      const pathText = error.instancePath
        ? error.instancePath.replace(/^\//, '').replace(/\//g, '.')
        : ROOT_INSTANCE_PATH_LABEL;
      return `${pathText}: ${error.message}`;
    });
    return { status: 'invalid', message: errors.join('; ') || 'schema validation failed' };
  }

  /**
   * Read and validate what the child wrote.
   *
   * An absent file is reported as a missing tool call rather than as invalid
   * output: the child never answered at all, which is a different fix.
   */
  async readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
    if (!fs.existsSync(runtime.outputPath)) {
      return { error: MISSING_STRUCTURED_OUTPUT_CALL_ERROR };
    }
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(runtime.outputPath, 'utf-8')) as unknown;
    } catch (error) {
      return { error: `Failed to read structured output: ${toMessage(error)}` };
    }
    try {
      const validation = await this.validateValue(runtime.schema, value);
      if (validation.status === 'invalid') {
        return { error: `Structured output validation failed: ${validation.message}` };
      }
    } catch (error) {
      // The compiler itself failed to load. That is an environment problem, and
      // reporting it against the run beats crashing the parent mid-orchestration.
      return { error: `Failed to validate structured output: ${toMessage(error)}` };
    }
    return { value };
  }
}
