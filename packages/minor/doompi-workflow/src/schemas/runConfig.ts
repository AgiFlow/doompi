import { z } from 'zod';

/** A YAML list, or one comma-separated string, as `--domains a,b` accepts. */
const nameList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(',')).map((name) => name.trim()).filter((name) => name.length > 0),
  );

const singleName = z.string().trim().min(1);

/**
 * The DoomPi keys of a workflow step's `runConfig`.
 *
 * The engine treats `runConfig` as an opaque map, so this is where a typo such
 * as `majormode` is caught instead of silently running on workspace defaults.
 */
export const doompiRunConfigSchema = z
  .object({
    majorMode: singleName.optional().describe('Major mode the step session runs in.'),
    minorModes: nameList.optional().describe('Minor modes activated in the step session.'),
    profile: singleName.optional().describe('Profile the step session runs as.'),
    domains: nameList.optional().describe('Domains selected for the step session. An empty list selects none.'),
    model: singleName.optional().describe('Model selector, provider/id.'),
    thinking: singleName.optional().describe('Thinking level for the model.'),
    subagentModel: singleName.optional().describe('Preferred Team subagent model, independent of the step model.'),
    subagentThinking: singleName.optional().describe('Preferred Team subagent thinking level.'),
  })
  .strict();

/**
 * The same keys for a templated step, whose `runConfig` is also the data its
 * command template reads: keys DoomPi does not use are left to the template.
 */
export const doompiTemplateRunConfigSchema = doompiRunConfigSchema.strip();

export type DoompiRunConfig = z.infer<typeof doompiRunConfigSchema>;

/** The runConfig keys DoomPi reads itself, the host keys `workflow-mcp doctor` checks steps against. */
export const DOOMPI_RUN_CONFIG_KEYS: readonly string[] = doompiRunConfigSchema.keyof().options;
