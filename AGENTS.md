# Project Grid working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- For implementation requests, use three independent reviewer agents as explicitly requested by the user. Assign bounded, complementary reviews of requirement coverage, visible behavior/regressions, and implementation quality/unnecessary code or assets. Adapt their concrete checks to the active request.
- Before reviewing, bind each acceptance criterion to the user's request or an established constraint. Reviewers report evidence, the unmet behavior, and a minimal correction. They do not silently add features or rewrite requirements.
- Keep reviewer agents read-only. The primary agent implements valid findings, then requests another review. Show material findings and their resolution in user-facing progress updates; do not report a pass before the relevant evidence exists.
- When a review opinion is unsupported, ambiguous, outside the request, or conflicts with established behavior, ask the user to confirm the intended requirement before implementing that opinion. Continue independent, already authorized fixes while clarification is pending.
- Record the requirement-to-change-to-verification mapping for substantial changes under `docs/reviews/`. Close required findings before declaring the task complete.
- Run native GUI checks sequentially with isolated `PROJECT_GRID_DATA_DIR` profiles. Never close, restart or type into the user's real Project Grid sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Manually completed projects stay steady green.
