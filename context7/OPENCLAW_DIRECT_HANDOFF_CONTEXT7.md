# Context7 references for OpenClaw direct handoff

Checked before implementation on 2026-05-09.

- discord.js v14.26.2: thread channels expose `parent_id`; message replies support `allowedMentions` with `parse`, `users`, `roles`, and `repliedUser`.
- Node.js v22 test runner: `test()` supports per-test timeout and `AbortSignal`; CLI supports `--test-timeout`.
- Jest v29.7.0: fake timers use `jest.useFakeTimers()` and `jest.advanceTimersByTime()` for async timer assertions.

Applied scope:

- Preserve parent channel allowlist while carrying thread id metadata.
- Keep Discord replies on empty `allowedMentions`.
- Use repo canonical `npm test` commands for verification.
