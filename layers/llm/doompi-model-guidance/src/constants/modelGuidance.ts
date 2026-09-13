export const DEFAULT_GUIDANCE = {
  'gpt-6-astra':
    'Continue executing an agreed plan and its scoped tasks without pausing for small decisions or repeated confirmation. Treat the accepted plan and task list as authorization to complete the work, make reasonable low-risk and reversible implementation choices, and verify the result. Ask only when blocked or when a decision would materially change scope, requirements, security, data safety, or destructive behavior.',
} as const;
export const DEFAULT_MODEL_GUIDANCE_PRESET = { modelGuidance: DEFAULT_GUIDANCE } as const;
