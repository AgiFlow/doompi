---
name: doompi-testing
description: Design, add, and run focused tests for repository behavior. Use for test implementation, regression coverage, verification, or diagnosing a failing test, not for a review-only request.
---

# Focused Testing

Produce evidence about observable behavior, not coverage for its own sake.

## Test design

- Read repository instructions and existing tests before selecting tools or commands.
- Translate the request into success, failure, boundary, and regression cases.
- Prefer the lowest-cost test level that can prove the behavior. Add broader integration or end-to-end coverage only when component boundaries matter.
- For a defect, reproduce it before changing the test or implementation when practical.

## Test implementation

- Follow nearby fixtures, helpers, naming, and isolation patterns.
- Assert public outcomes rather than private implementation details.
- Keep tests deterministic. Control time, randomness, network calls, and shared state where needed.
- Do not weaken an existing assertion merely to make a failure disappear.

## Evidence

- Run the focused test first, then the relevant repository test target and required quality checks.
- Separate observed command results from inferred coverage.
- Report failed commands with the useful failure context and state what remains unverified.

Do not modify production code unless the user also requested a fix or implementation.
