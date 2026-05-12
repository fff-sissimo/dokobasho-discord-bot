# OpenClaw Discord n8n workflows

This directory is the source of truth for the OpenClaw Discord n8n workflows.
They are not auto-imported by Docker Compose. Provision them with the n8n MCP
workflow SDK before enabling `discord.server_read` or `discord.safe_write` in
production.

## Workflows

- `openclaw-discord-read.js`
  - webhook path: `openclaw/discord-read`
  - workflow key: `discord.server_read`
  - production workflow id: `WA3vlk2gTUDFfrgm`
- `openclaw-discord-write.js`
  - webhook path: `openclaw/discord-write`
  - workflow key: `discord.safe_write`
  - production workflow id: `vjGcfoCIIfVvwfkq`

## Provisioning

Use the official n8n MCP flow:

1. Validate each source with `validate_workflow`.
2. Create or update the workflow from the matching source file.
3. Publish the workflow.
4. Recreate `n8n` and `n8n-runners` so they receive `OPENCLAW_N8N_DISPATCH_SECRET`
   and `DISCORD_BOT_TOKEN` / `BOT_TOKEN`.

The OpenClaw API has default workflow URLs for these paths, so
`OPENCLAW_N8N_WORKFLOW_URLS_JSON` is only needed when the webhook paths differ.
Keep `OPENCLAW_N8N_DISPATCH_ENABLED=true`,
`OPENCLAW_N8N_ALLOWED_WORKFLOWS=notion.safe_ops,discord.server_read,discord.safe_write`,
and put `skills/n8n-workflow-dispatcher/SKILL.md` at the front of
`OPENCLAW_PROMPT_FILES` for direct mode. Use
`OPENCLAW_WORKSPACE_CONTEXT_MAX_CHARS=12000` or higher so the dispatcher skill
is not truncated out of the runtime prompt.

## Runtime boundary

- Discord bot tokens belong only to `n8n` and `n8n-runners`.
- `openclaw-api` holds only the n8n dispatch secret and sends safe metadata to
  n8n. The OpenClaw child process does not receive the dispatch secret.
- Read and write are separated. The write workflow only supports current
  channel/thread message send and current channel thread creation.
