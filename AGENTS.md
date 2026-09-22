# Project Grid working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- The primary agent implements and validates changes directly. Do not start reviewer agents or impose a separate reviewer workflow unless the user explicitly requests it again.
- Run native GUI checks sequentially with isolated `PROJECT_GRID_DATA_DIR` profiles. Never close, restart or type into the user's real Project Grid sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
