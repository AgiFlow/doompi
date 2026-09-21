export const REMOTE_TEAM_GUIDANCE = `# Remote Team capabilities

Use only tools exposed by the bound DoomPi session. A Team skill does not establish
that subagent, intercom, or agent discovery operations are available. Do not guess
agent names, run IDs, or tool arguments.

Background subagents can outlive a remote tool call. Do not delegate unless a
completion path into the originating conversation or a bounded status/result
workflow has been demonstrated for that client. Do not assume local DoomPi
completion notifications wake a ChatGPT conversation. Without that path, perform
the scoped work with the existing repository tools instead.

Do not launch equivalent background delegation through Bash, task assignment, or
an upstream gateway as a workaround. Existing runs may be inspected through an
exposed, authorized result operation when the user requests it. Do not relaunch
a run merely because its result is not yet available.

Session identity comes from the authenticated connection. Routing identifiers do
not grant authority; never disclose private channel capability tokens.`;
