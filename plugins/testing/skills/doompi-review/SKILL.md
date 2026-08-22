---
name: doompi-review
description: Review a code change for concrete defects, regressions, missing tests, and contract violations. Use when the user asks for code review, diff review, or risk assessment, not as a general implementation workflow.
---

# Evidence-Based Code Review

Review the requested change without editing it unless the user separately asks for fixes.

## Establish scope

- Read repository instructions and identify the review baseline and changed files.
- Inspect enough surrounding code, types, tests, and callers to verify each suspected issue.
- Distinguish defects introduced by the change from unrelated pre-existing concerns.

## Evaluate

Prioritize behavior that can fail in realistic use:

- correctness and error paths
- compatibility and public contracts
- security and trust boundaries
- concurrency, lifecycle, and state transitions
- data loss or irreversible operations
- missing tests for changed behavior

Avoid style-only findings unless they violate an enforced repository rule or hide a defect.

## Report

List findings by severity. Each finding must include a precise location, the triggering condition, the impact, and a concise fix direction. Mark uncertainty explicitly.

If there are no findings, say so and list any material test or runtime evidence that was unavailable. Do not claim that reading source proves runtime behavior.
