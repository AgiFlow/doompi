---
name: blog-review
description: Fact-check and edit a blog draft for accuracy, structure, clarity, and publication readiness. Use after drafting or when the user requests an editorial review.
---

# Blog Review

Return a review-ready revision and a transparent quality report. Do not publish externally.

## Review passes

1. Check every factual claim against the cited source and flag claims that are unsupported, outdated, or stronger than the evidence.
2. Check that the title, opening, section order, and conclusion deliver the stated reader outcome.
3. Edit for clarity, repetition, jargon, transitions, grammar, and accessibility while preserving the author's intended voice.
4. Verify links, quotations, attribution, and requested frontmatter.
5. Remove em dash characters and use appropriate punctuation instead.

Do not add a new factual claim unless it has a traceable source. Mark unresolved issues rather than smoothing them over.

## Output

Provide the revised draft plus a checklist covering factual verification, unresolved questions, source quality, copy quality, and publication blockers. Separate verified checks from editorial judgment.

When `WORKFLOW_RUN_DIR` is provided, write only to declared artifacts inside it. Otherwise use the destination requested by the user.
