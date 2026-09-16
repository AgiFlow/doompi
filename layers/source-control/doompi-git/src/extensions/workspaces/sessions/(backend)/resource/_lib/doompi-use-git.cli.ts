export function createDoompiUseGitResource(moduleUrl: string) {
  return {
    source: '@agimon-ai/doompi-git',
    moduleUrl,
    skills: [
      {
        name: 'doompi-use-git',
        description:
          'Use @agimon-ai/doompi-git: Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent',
      },
    ],
  };
}
