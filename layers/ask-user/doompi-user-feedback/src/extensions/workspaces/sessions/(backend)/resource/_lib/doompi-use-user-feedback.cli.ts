export function createDoompiUseUserFeedbackResource(moduleUrl: string) {
  return {
    source: '@agimon-ai/doompi-user-feedback',
    moduleUrl,
    skills: [
      {
        name: 'doompi-use-user-feedback',
        description:
          'Use @agimon-ai/doompi-user-feedback: Structured user questions with interactive and autonomous Voice handoff for Pi agents.',
      },
    ],
  };
}
