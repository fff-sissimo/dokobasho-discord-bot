import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'OpenClaw Discord Read Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'openclaw/discord-read',
      responseMode: 'responseNode',
    },
    position: [240, 300],
  },
  output: [{ headers: {}, body: { workflow_key: 'discord.server_read' } }],
});

const prepareFirstRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Discord Read Request',
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
const snowflake = /^\\d{17,20}$/;
const apiBase = 'https://discord.com/api/v10';

const fail = (reason, safeReply) => [{
  json: {
    final: true,
    skip_discord: true,
    discord_url: apiBase + '/gateway',
    ok: false,
    reason,
    safe_reply: safeReply || '-# Discord read workflow を実行できませんでした。',
    results: [],
  },
}];

if (!expectedSecret || providedSecret !== expectedSecret) return fail('unauthorized');
if (!String(env.DISCORD_BOT_TOKEN || env.BOT_TOKEN || '')) return fail('discord_token_not_configured');
if (body.workflow_key !== 'discord.server_read') return fail('discord_workflow_key_mismatch');

const request = body.dispatch_request || {};
const operation = String(request.operation || body.operation || '');
const allowedOps = new Set([
  'discord.fetch_recent_summary',
  'discord.fetch_messages',
  'discord.fetch_thread_messages',
  'discord.list_channels',
  'discord.list_active_threads',
]);
if (!allowedOps.has(operation)) return fail('discord_read_operation_not_allowed');

const discord = body.discord || {};
const target = request.target || {};
const input = request.input || {};
const guildId = String(target.guild_id || discord.guild_id || '');
if (!snowflake.test(guildId)) return fail('discord_read_guild_required');

const targetId = String(target.thread_id || target.channel_id || '');
const maxChannels = Math.max(1, Math.min(Number(input.max_channels || 30), 50));
const messagesPerChannel = Math.max(1, Math.min(Number(input.messages_per_channel || input.limit || 8), 20));
const lookbackHours = Math.max(1, Math.min(Number(input.lookback_hours || 168), 168));

let discordPath = '/guilds/' + guildId + '/channels';
if (operation === 'discord.list_active_threads') {
  discordPath = '/guilds/' + guildId + '/threads/active';
} else if (operation === 'discord.fetch_messages' || operation === 'discord.fetch_thread_messages') {
  if (!snowflake.test(targetId)) return fail('discord_read_target_required');
  discordPath = '/channels/' + targetId + '/messages?limit=' + messagesPerChannel;
} else if (operation === 'discord.fetch_recent_summary' && snowflake.test(targetId)) {
  discordPath = '/channels/' + targetId + '/messages?limit=' + messagesPerChannel;
}

return [{
  json: {
    final: false,
    skip_discord: false,
    discord_url: apiBase + discordPath,
    request_id: request.id || 'discord_read',
    workflow_key: 'discord.server_read',
    operation,
    guild_id: guildId,
    target_id: targetId,
    max_channels: maxChannels,
    messages_per_channel: messagesPerChannel,
    lookback_hours: lookbackHours,
    since_ms: Date.now() - lookbackHours * 60 * 60 * 1000,
  },
}];
`,
    },
    position: [500, 300],
  },
  output: [{
    discord_url: 'https://discord.com/api/v10/guilds/840827137451229205/channels',
    operation: 'discord.fetch_recent_summary',
  }],
});

const firstDiscordRequest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Discord Read First HTTP Request',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.discord_url }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          {
            name: 'Authorization',
            value: expr('{{ $json.skip_discord ? "" : "Bot " + ($env.DISCORD_BOT_TOKEN || $env.BOT_TOKEN || "") }}'),
          },
          { name: 'Accept', value: 'application/json' },
        ],
      },
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

const buildMessageRequests = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Discord Message Requests',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const firstResponse = $input.first().json;
const prepared = $('Prepare Discord Read Request').first().json;
const apiBase = 'https://discord.com/api/v10';
const snowflake = /^\\d{17,20}$/;
const safeText = (value, max = 160) => String(value || '')
  .replace(/\\r\\n/g, '\\n')
  .replace(/@everyone|@here/gi, '')
  .replace(/<@&\\d+>|<@!?\\d+>|<#\\d+>/g, '')
  .replace(/https?:\\/\\/\\S+/gi, '')
  .replace(/(?:api[_-]?key|token|secret|password|passwd|authorization)\\s*[:=]\\s*[^\\s]+/gi, '')
  .replace(/(?:bearer|basic)\\s+[a-z0-9._~+/=-]{8,}/gi, '')
  .replace(/\\s+/g, ' ')
  .trim()
  .slice(0, max);

const final = (payload) => [{ json: { final: true, skip_discord: true, discord_url: apiBase + '/gateway', ...payload } }];
const fail = (reason) => final({ ok: false, reason, safe_reply: '-# Discord read workflow を実行できませんでした。', results: [] });

if (prepared.final) return final(prepared);
const statusCode = Number(firstResponse.statusCode || 0);
if (statusCode < 200 || statusCode >= 300) {
  const reason = statusCode === 403 ? 'discord_forbidden' : 'discord_http_' + (statusCode || 'unknown');
  return fail(reason);
}

const body = firstResponse.body;
const operation = prepared.operation;
const requestId = prepared.request_id || 'discord_read';

if (operation === 'discord.list_channels') {
  const channels = (Array.isArray(body) ? body : [])
    .filter((channel) => [0, 5, 10, 11, 12, 15, 16].includes(Number(channel.type)))
    .slice(0, prepared.max_channels)
    .map((channel) => ({
      id: String(channel.id || ''),
      name: safeText(channel.name, 80),
      type: Number(channel.type),
      parent_id: channel.parent_id ? String(channel.parent_id) : '',
    }));
  return final({
    ok: true,
    reason: 'ok',
    safe_reply: 'Discord サーバーのチャンネル一覧を確認しました。\\n- 対象: ' + channels.length + ' 件',
    results: [{ id: requestId, workflow_key: 'discord.server_read', operation, status: 'ok', summary: 'channels=' + channels.length, channels }],
  });
}

if (operation === 'discord.list_active_threads') {
  const threads = (Array.isArray(body && body.threads) ? body.threads : [])
    .slice(0, prepared.max_channels)
    .map((thread) => ({
      id: String(thread.id || ''),
      name: safeText(thread.name, 80),
      type: Number(thread.type),
      parent_id: thread.parent_id ? String(thread.parent_id) : '',
    }));
  return final({
    ok: true,
    reason: 'ok',
    safe_reply: 'Discord サーバーの active thread を確認しました。\\n- 対象: ' + threads.length + ' 件',
    results: [{ id: requestId, workflow_key: 'discord.server_read', operation, status: 'ok', summary: 'threads=' + threads.length, threads }],
  });
}

if ((operation === 'discord.fetch_messages' || operation === 'discord.fetch_thread_messages' || prepared.target_id) && Array.isArray(body)) {
  return final({
    ok: true,
    reason: 'ok',
    source_messages: body.map((message) => ({
      channel_id: prepared.target_id,
      channel_name: prepared.target_id,
      timestamp: Date.parse(message.timestamp || ''),
      content: safeText(message.content, 240),
    })),
    request_id: requestId,
    operation,
  });
}

const channels = (Array.isArray(body) ? body : [])
  .filter((channel) => [0, 5, 15, 16].includes(Number(channel.type)) && snowflake.test(String(channel.id || '')))
  .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
  .slice(0, prepared.max_channels);

if (!channels.length) {
  return final({
    ok: true,
    reason: 'ok',
    safe_reply: 'Discord サーバーの直近投稿を確認しました。\\n- 対象: 0 channel/thread、0 messages',
    results: [{ id: requestId, workflow_key: 'discord.server_read', operation, status: 'ok', summary: 'channels=0, messages=0' }],
  });
}

return channels.map((channel) => ({
  json: {
    final: false,
    skip_discord: false,
    discord_url: apiBase + '/channels/' + channel.id + '/messages?limit=' + prepared.messages_per_channel,
    request_id: requestId,
    workflow_key: 'discord.server_read',
    operation,
    channel_id: String(channel.id),
    channel_name: safeText(channel.name, 80),
    since_ms: prepared.since_ms,
  },
}));
`,
    },
    position: [1020, 300],
  },
  output: [{ discord_url: 'https://discord.com/api/v10/channels/1094907178671939654/messages?limit=2' }],
});

const messageDiscordRequest = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Discord Read Message HTTP Requests',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.discord_url }}'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          {
            name: 'Authorization',
            value: expr('{{ $json.skip_discord ? "" : "Bot " + ($env.DISCORD_BOT_TOKEN || $env.BOT_TOKEN || "") }}'),
          },
          { name: 'Accept', value: 'application/json' },
        ],
      },
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
    position: [1280, 300],
  },
});

const summarizeRead = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarize Discord Read Result',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `
const responses = $input.all().map((item) => item.json);
const requests = $('Build Discord Message Requests').all().map((item) => item.json);
const prepared = $('Prepare Discord Read Request').first().json;
const terminal = requests.find((request) => request.final);
const safeText = (value, max = 160) => String(value || '')
  .replace(/\\r\\n/g, '\\n')
  .replace(/@everyone|@here/gi, '')
  .replace(/<@&\\d+>|<@!?\\d+>|<#\\d+>/g, '')
  .replace(/https?:\\/\\/\\S+/gi, '')
  .replace(/(?:api[_-]?key|token|secret|password|passwd|authorization)\\s*[:=]\\s*[^\\s]+/gi, '')
  .replace(/(?:bearer|basic)\\s+[a-z0-9._~+/=-]{8,}/gi, '')
  .replace(/\\s+/g, ' ')
  .trim()
  .slice(0, max);

if (terminal && !Array.isArray(terminal.source_messages)) {
  return [{ json: terminal }];
}

const operation = (terminal && terminal.operation) || prepared.operation || 'discord.fetch_recent_summary';
const requestId = (terminal && terminal.request_id) || prepared.request_id || 'discord_read';
const messages = [];
const failures = [];

if (terminal && Array.isArray(terminal.source_messages)) {
  for (const message of terminal.source_messages) {
    messages.push(message);
  }
} else {
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index] || {};
    const request = requests[index] || {};
    const statusCode = Number(response.statusCode || 0);
    if (statusCode < 200 || statusCode >= 300) {
      failures.push(request.channel_id || 'unknown');
      continue;
    }
    const body = Array.isArray(response.body) ? response.body : [];
    for (const message of body) {
      const timestamp = Date.parse(message.timestamp || '');
      if (Number.isFinite(timestamp) && timestamp < Number(request.since_ms || 0)) continue;
      messages.push({
        channel_id: String(request.channel_id || ''),
        channel_name: safeText(request.channel_name || request.channel_id, 80),
        timestamp,
        content: safeText(message.content, 240),
      });
    }
  }
}

const channelCounts = new Map();
const termCounts = new Map();
const stopWords = new Set(['です', 'ます', 'する', 'した', 'して', 'これ', 'それ', 'ため', 'よう', 'こと', 'さん', 'あり', 'なし', 'openclaw-api']);
for (const message of messages) {
  const channelName = message.channel_name || message.channel_id || 'unknown';
  channelCounts.set(channelName, (channelCounts.get(channelName) || 0) + 1);
  const terms = String(message.content || '').match(/[A-Za-z0-9_+#.-]{2,}|[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}ー]{2,}/gu) || [];
  for (const rawTerm of terms) {
    const term = safeText(rawTerm.toLowerCase(), 40);
    if (term && !stopWords.has(term) && term.length >= 2) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
  }
}

const activeChannels = [...channelCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, count]) => '#' + name + ' ' + count + '件');
const topTerms = [...termCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([term]) => term);

const lines = [
  'Discord サーバーの直近投稿を確認しました。',
  '- 対象: ' + requests.filter((request) => !request.final).length + ' channel/thread、' + messages.length + ' messages',
  activeChannels.length ? '- 活発な場所: ' + activeChannels.join(', ') : '- 活発な場所: 確認できた投稿はありません',
  topTerms.length ? '- 多かった話題語: ' + topTerms.join(', ') : '- 多かった話題語: 抽出できませんでした',
];
if (failures.length) lines.push('- 読めなかった場所: ' + failures.length + ' 件');

return [{
  json: {
    ok: true,
    reason: 'ok',
    safe_reply: lines.join('\\n'),
    results: [{
      id: requestId,
      workflow_key: 'discord.server_read',
      operation,
      status: 'ok',
      summary: 'channels=' + requests.filter((request) => !request.final).length + ', messages=' + messages.length,
    }],
  },
}];
`,
    },
    position: [1540, 300],
  },
  output: [{ ok: true, safe_reply: 'Discord サーバーの直近投稿を確認しました。', results: [] }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond With Safe Summary',
    parameters: {
      respondWith: 'firstIncomingItem',
      options: {
        responseCode: 200,
      },
    },
    position: [1800, 300],
  },
});

export default workflow('openclaw-discord-read', 'OpenClaw Discord Read')
  .add(webhookTrigger)
  .to(prepareFirstRequest)
  .to(firstDiscordRequest)
  .to(buildMessageRequests)
  .to(messageDiscordRequest)
  .to(summarizeRead)
  .to(respond);
