import { workflow, node, trigger } from '@n8n/workflow-sdk';

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

const writeDiscord = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Execute Safe Discord Write',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const item = $input.first().json;
const headers = item.headers || {};
const body = item.body || {};
const expectedSecret = String(process.env.OPENCLAW_N8N_DISPATCH_SECRET || '');
const providedSecret = String(headers['x-webhook-secret'] || headers['X-Webhook-Secret'] || '');
const token = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || '');
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
    ok: false,
    reason,
    safe_reply: safeReply || '-# Discord write workflow を実行できませんでした。',
    results: [],
  },
}];

if (!expectedSecret || providedSecret !== expectedSecret) return fail('unauthorized');
if (!token) return fail('discord_token_not_configured');
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

const discordRequest = async (path, options = {}, retry = true) => {
  const response = await fetch(apiBase + path, {
    ...options,
    headers: {
      authorization: 'Bot ' + token,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 429 && retry) {
    const retryPayload = await response.json().catch(() => ({}));
    const waitMs = Math.min(Number(retryPayload.retry_after || 1) * 1000, 3000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return discordRequest(path, options, false);
  }
  if (!response.ok) {
    const code = response.status === 403 ? 'discord_forbidden' : 'discord_http_' + response.status;
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return response.status === 204 ? {} : response.json();
};

try {
  const channel = await discordRequest('/channels/' + currentChannelId);
  if (String(channel.guild_id || '') !== guildId) return fail('discord_write_guild_mismatch');

  if (operation === 'discord.send_message') {
    const sent = await discordRequest('/channels/' + currentChannelId + '/messages', {
      method: 'POST',
      body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
    });
    return [{
      json: {
        ok: true,
        reason: 'ok',
        safe_reply: 'Discord にメッセージを送信しました。',
        results: [{
          id: request.id || 'discord_write',
          workflow_key: 'discord.safe_write',
          operation,
          status: 'ok',
          channel_id: currentChannelId,
          message_id: String(sent.id || ''),
          summary: 'message_sent',
        }],
      },
    }];
  }

  if (operation === 'discord.send_thread_message') {
    if (!snowflake.test(targetThreadId || currentThreadId)) return fail('discord_thread_required');
    const threadId = targetThreadId || currentThreadId;
    const sent = await discordRequest('/channels/' + threadId + '/messages', {
      method: 'POST',
      body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
    });
    return [{
      json: {
        ok: true,
        reason: 'ok',
        safe_reply: 'Discord thread にメッセージを送信しました。',
        results: [{
          id: request.id || 'discord_write',
          workflow_key: 'discord.safe_write',
          operation,
          status: 'ok',
          thread_id: threadId,
          message_id: String(sent.id || ''),
          summary: 'thread_message_sent',
        }],
      },
    }];
  }

  let thread;
  if ((channel.type === 0 || channel.type === 5) && snowflake.test(currentMessageId)) {
    thread = await discordRequest('/channels/' + currentChannelId + '/messages/' + currentMessageId + '/threads', {
      method: 'POST',
      body: JSON.stringify({ name: title, auto_archive_duration: 1440 }),
    });
    if (content) {
      await discordRequest('/channels/' + thread.id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
      });
    }
  } else if (channel.type === 15 || channel.type === 16) {
    thread = await discordRequest('/channels/' + currentChannelId + '/threads', {
      method: 'POST',
      body: JSON.stringify({
        name: title,
        auto_archive_duration: 1440,
        message: { content: content || title, allowed_mentions: allowedMentions },
      }),
    });
  } else {
    thread = await discordRequest('/channels/' + currentChannelId + '/threads', {
      method: 'POST',
      body: JSON.stringify({ name: title, auto_archive_duration: 1440, type: 11 }),
    });
    if (content) {
      await discordRequest('/channels/' + thread.id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
      });
    }
  }

  return [{
    json: {
      ok: true,
      reason: 'ok',
      safe_reply: 'スレッドを作成しました。\\n対象: ' + title,
      results: [{
        id: request.id || 'discord_write',
        workflow_key: 'discord.safe_write',
        operation,
        status: 'ok',
        channel_id: currentChannelId,
        thread_id: String(thread.id || ''),
        summary: 'thread_created',
      }],
    },
  }];
} catch (error) {
  const reason = String(error.code || 'discord_write_failed').replace(/[^a-z0-9_:-]+/gi, '_').slice(0, 80);
  return fail(reason);
}
`,
    },
    position: [540, 300],
  },
  output: [{ ok: true, safe_reply: 'Discord にメッセージを送信しました。', results: [] }],
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
    position: [840, 300],
  },
});

export default workflow('openclaw-discord-write', 'OpenClaw Discord Write')
  .add(webhookTrigger)
  .to(writeDiscord)
  .to(respond);
