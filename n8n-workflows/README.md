# Retired OpenClaw Discord n8n workflows

OpenClaw direct runtime was retired on 2026-05-13. This directory is retained
only as historical source for the existing n8n workflows until they are
exported, disabled, or deleted in a separate n8n change.

Do not provision these workflows for a new runtime. Docker Compose does not
auto-import them.

## Workflows

- `openclaw-discord-read.js`
  - webhook path: `openclaw/discord-read`
  - workflow key: `discord.server_read`
  - production workflow id: `WA3vlk2gTUDFfrgm`
- `openclaw-discord-write.js`
  - webhook path: `openclaw/discord-write`
  - workflow key: `discord.safe_write`
  - production workflow id: `vjGcfoCIIfVvwfkq`

## Retirement boundary

- The workflow source files are not changed in the OpenClaw retirement pass.
- `OPENCLAW_N8N_DISPATCH_SECRET` remains available to `n8n` and `n8n-runners`
  while the old live workflows still exist, so a container recreate does not
  silently change their authorization behavior.
- The retired `openclaw-api` service is no longer provisioned. No new runtime
  should call these workflow webhooks.
- Later n8n cleanup should export the live workflows, disable them, and then
  remove this directory and the compatibility secret from compose.

## Runtime boundary

- Discord bot tokens belong only to `n8n` and `n8n-runners`.
- Read and write are separated. The write workflow only supports current
  channel/thread message send and current channel thread creation.
