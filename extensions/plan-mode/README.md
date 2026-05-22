# Plan Mode Extension

Basic read-only plan mode.

## Controls

- `F2` — toggle plan mode on/off (on macOS you may need `fn+F2`)
- `/plan` — toggle plan mode on/off
- `--plan` — start a session in plan mode

## Behavior

When plan mode is on:

- Footer shows `⏸ plan`
- Tools are restricted to `read`, `bash`, `grep`, `find`, `ls`
- Bash commands are filtered through the read-only allowlist
- The agent is instructed to inspect/reason only and produce a concise implementation plan

Press `F2` again to turn plan mode off and restore normal tools.
