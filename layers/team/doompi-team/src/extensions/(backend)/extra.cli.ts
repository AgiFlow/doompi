import { createTeamPiRuntime } from '../../controllers/teamPiRuntime';

/**
 * The interactive host's contributions, as one factory.
 *
 * Every surface this package feeds on the CLI reads the same per-mount object
 * graph, so this is one lifetime rather than a file per surface. The hatch is
 * where the convention puts a contribution set the path cannot decompose, and
 * it stays a one-line re-export: the runtime itself is a controller.
 */
export default createTeamPiRuntime;
