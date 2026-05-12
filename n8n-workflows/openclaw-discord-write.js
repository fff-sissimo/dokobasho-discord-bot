import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'OpenClaw Discord Write Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'openclaw/discord-write',
      responseMode: 'responseNode',
    },
    position: [240, 300],
  },
  output: [{ headers: {}, body: { workflow_key: 'discord.safe_write' } }],
});

const prepareWriteRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Discord Write Request',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const item = $input.first().json;
const headers = item.headers || {};
const body = item.body || {};
const env = typeof $env === 'object' && $env ? $env : {};
const expectedSecret = String(env.OPENCLAW_N8N_DISPATCH_SECRET || '');
const providedSecret = String(headers['x-webhook-secret'] || headers['X-Webhook-Secret'] || '');
const apiBase = 'https://discord.com/api/v10';
const snowflake = /^\\d{17,20}$/;
const allowedMentions = { parse: [], users: [], roles: [], replied_user: false };

const safeText = (value, max = 1600) => String(value || '')
  .replace(/\\r\\n/g, '\\n')
  .replace(/@everyone|@here/gi, '')
  .replace(/<@&\\d+>|<@!?\\d+>|<#\\d+>/g, '')
  .replace(/https?:\\/\\/\\S+/gi, '')
  .replace(/(?:api[_-]?key|token|secret|password|passwd|authorization)\\s*[:=]\\s*[^\\s]+/gi, '')
  .replace(/(?:bearer|basic)\\s+[a-z0-9._~+/=-]{8,}/gi, '')
  .split('\\n')
  .map((line) => line.replace(/\\s+/g, ' ').trim())
  .filter(Boolean)
  .join('\\n')
  .trim()
  .slice(0, max);

const fail = (reason, safeReply) => [{
  json: {
    final: true,
    skip_discord: true,
    discord_url: apiBase + '/gateway',
    discord_method: 'GET',
    ok: false,
    reason,
    safe_reply: safeReply || '-# Discord write workflow を実行できませんでした。',
    results: [],
  },
}];

if (!expectedSecret || providedSecret !== expectedSecret) return fail('unauthorized');
if (!String(env.DISCORD_BOT_TOKEN || env.BOT_TOKEN || '')) return fail('discord_token_not_configured');
if (body.workflow_key !== 'discord.safe_write') return fail('discord_workflow_key_mismatch');

const request = body.dispatch_request || {};
const operation = String(request.operation || body.operation || '');
const allowedOps = new Set(['discord.send_message', 'discord.create_thread', 'discord.send_thread_message']);
if (!allowedOps.has(operation)) return fail('discord_write_operation_not_allowed');

const discord = body.discord || {};
const guildId = String(discord.guild_id || '');
const currentChannelId = String(discord.channel_id || '');
const currentThreadId = String(discord.thread_id || '');
const currentMessageId = String(discord.message_id || '');
const target = request.target || {};
const targetChannelId = String(target.channel_id || currentChannelId || '');
const targetThreadId = String(target.thread_id || currentThreadId || '');
if (!snowflake.test(guildId) || !snowflake.test(currentChannelId)) return fail('discord_write_context_required');
if (target.guild_id && String(target.guild_id) !== guildId) return fail('discord_write_guild_mismatch');
if (targetChannelId !== currentChannelId && targetChannelId !== currentThreadId) return fail('discord_write_target_mismatch');
if (targetThreadId && targetThreadId !== currentThreadId && targetThreadId !== currentChannelId) return fail('discord_write_target_mismatch');
if (operation === 'discord.create_thread' && currentThreadId) return fail('discord_thread_create_from_thread_denied');

const input = request.input || {};
const rawText = [input.content, input.body, input.message, input.title, input.thread_name, input.name]
  .map((value) => String(value || ''))
  .join('\\n');
if (input.blocked_content === true ||
  /@everyone|@here|<@&\\d+>|https?:\\/\\//i.test(rawText) ||
  (Array.isArray(input.attachments) && input.attachments.length > 0) ||
  (Array.isArray(input.embeds) && input.embeds.length > 0)) {
  return fail('discord_write_content_denied');
}

const content = safeText(input.content || input.body || input.message, 1600);
const title = safeText(input.title || input.thread_name || input.name, 100);
if (/^\\s*$/.test(content) && operation !== 'discord.create_thread') return fail('discord_write_content_required');
if (operation === 'discord.create_thread' && !title) return fail('discord_thread_title_required');

let discordPath = '/channels/' + currentChannelId + '/messages';
let discordBody = { content, allowed_mentions: allowedMentions };
let resultKind = 'message_sent';
let targetId = currentChannelId;

if (operation === 'discord.send_thread_message') {
  const threadId = targetThreadId || currentThreadId;
  if (!snowflake.test(threadId)) return fail('discord_thread_required');
  discordPath = '/channels/' + threadId + '/messages';
  targetId = threadId;
  resultKind = 'thread_message_sent';
} else if (operation === 'discord.create_thread') {
  resultKind = 'thread_created';
  if (snowflake.test(currentMessageId) && currentMessageId !== '0') {
    discordPath = '/channels/' + currentChannelId + '/messages/' + currentMessageId + '/threads';
    discordBody = { name: title, auto_archive_duration: 1440 };
  } else {
    discordPath = '/channels/' + currentChannelId + '/threads';
    discordBody = { name: title, auto_archive_duration: 1440, type: 11 };
  }
}

return [{
  json: {
    final: false,
    skip_discord: false,
    request_id: request.id || 'discord_write',
    workflow_key: 'discord.safe_write',
    operation,
    result_kind: resultKind,
    title,
    content,
    current_channel_id: currentChannelId,
    target_id: targetId,
    discord_method: 'POST',
    discord_url: apiBase + discordPath,
    discord_body: discordBody,
  },
}];
`,
    },
    position: [500, 300],
  },
  output: [{ discord_url: 'https://discord.com/api/v10/channels/1094907178671939654/threads' }],
});

const discordWriteRequest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Discord Write HTTP Request',
    parameters: {
      method: expr('{{ $json.discord_method }}'),
      url: expr('{{ $json.discord_url }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          {
            name: 'Authorization',
            value: expr('{{ $json.skip_discord ? "" : "Bot " + ($env.DISCORD_BOT_TOKEN || $env.BOT_TOKEN || "") }}'),
          },
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Accept', value: 'application/json' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ $json.discord_body || {} }}'),
      options: {
        timeout: 20000,
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'json',
          },
        },
      },
    },
    position: [760, 300],
  },
});

const summarizeWrite = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarize Discord Write Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const response = $input.first().json;
const prepared = $('Prepare Discord Write Request').first().json;
if (prepared.final) return [{ json: prepared }];

const statusCode = Number(response.statusCode || 0);
if (statusCode < 200 || statusCode >= 300) {
  const reason = statusCode === 403 ? 'discord_forbidden' : 'discord_http_' + (statusCode || 'unknown');
  return [{
    json: {
      ok: false,
      reason,
      safe_reply: '-# Discord write workflow を実行できませんでした。',
      results: [],
    },
  }];
}

const body = response.body || {};
const result = {
  id: prepared.request_id || 'discord_write',
  workflow_key: 'discord.safe_write',
  operation: prepared.operation,
  status: 'ok',
  channel_id: prepared.current_channel_id,
  summary: prepared.result_kind,
};
let safeReply = 'Discord にメッセージを送信しました。';
if (prepared.operation === 'discord.send_thread_message') {
  result.thread_id = prepared.target_id;
  result.message_id = String(body.id || '');
  safeReply = 'Discord thread にメッセージを送信しました。';
} else if (prepared.operation === 'discord.create_thread') {
  result.thread_id = String(body.id || '');
  safeReply = 'スレッドを作成しました。\\n対象: ' + prepared.title;
} else {
  result.message_id = String(body.id || '');
}

return [{
  json: {
    ok: true,
    reason: 'ok',
    safe_reply: safeReply,
    results: [result],
  },
}];
`,
    },
    position: [1020, 300],
  },
  output: [{ ok: true, safe_reply: 'スレッドを作成しました。', results: [] }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond With Safe Write Result',
    parameters: {
      respondWith: 'firstIncomingItem',
      options: {
        responseCode: 200,
      },
    },
    position: [1280, 300],
  },
});

export default workflow('openclaw-discord-write', 'OpenClaw Discord Write')
  .add(webhookTrigger)
  .to(prepareWriteRequest)
  .to(discordWriteRequest)
  .to(summarizeWrite)
  .to(respond);
