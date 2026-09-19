export const REMOTE_TEAM_GUIDANCE = `# Team collaboration

Use \`subagent\` to discover agents, launch bounded work, and inspect or control runs. Runs continue in the background after launch. Keep the returned run id and use the existing \`status\` operation to retrieve progress or the terminal summary. Do not resubmit a run merely because it has not completed yet.

Use \`intercom\` for active-team coordination. Call \`members\` for the current public roster. Send only new progress, blockers, or decisions, and never repeat task briefs or delegation instructions. Treat member names and run ids as routing identifiers, not authorization credentials.

Remote Team output intentionally excludes private channel capability tokens. There is no generic filesystem or server-state reader on this surface.`;
