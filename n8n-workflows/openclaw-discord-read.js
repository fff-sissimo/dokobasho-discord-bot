import { workflow, node, trigger } from '@n8n/workflow-sdk';

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

const readDiscord = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fetch Discord Server Summary',
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

const fail = (reason, safeReply) => [{
  json: {
    ok: false,
    reason,
    safe_reply: safeReply || '-# Discord read workflow を実行できませんでした。',
    results: [],
  },
}];

if (!expectedSecret || providedSecret !== expectedSecret) return fail('unauthorized');
if (!token) return fail('discord_token_not_configured');
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
const guildId = String((request.target && request.target.guild_id) || discord.guild_id || '');
if (!snowflake.test(guildId)) return fail('discord_read_guild_required');

const input = request.input || {};
const maxChannels = Math.max(1, Math.min(Number(input.max_channels || 30), 50));
const messagesPerChannel = Math.max(1, Math.min(Number(input.messages_per_channel || input.limit || 8), 20));
const includeThreads = input.include_threads !== false;
const lookbackHours = Math.max(1, Math.min(Number(input.lookback_hours || 168), 168));
const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;

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
  return response.json();
};

try {
  const channels = await discordRequest('/guilds/' + guildId + '/channels');
  const activeThreadsResponse = includeThreads || operation === 'discord.list_active_threads' || operation === 'discord.fetch_thread_messages'
    ? await discordRequest('/guilds/' + guildId + '/threads/active').catch(() => ({ threads: [] }))
    : { threads: [] };
  const activeThreads = Array.isArray(activeThreadsResponse.threads) ? activeThreadsResponse.threads : [];
  const readableTypes = new Set([0, 5, 10, 11, 12]);
  const channelById = new Map(channels.map((channel) => [String(channel.id), channel]));
  let candidates = channels
    .filter((channel) => readableTypes.has(channel.type))
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .slice(0, maxChannels);

  if (operation === 'discord.fetch_messages' && request.target && request.target.channel_id) {
    candidates = candidates.filter((channel) => String(channel.id) === String(request.target.channel_id));
  } else if (operation === 'discord.fetch_thread_messages' && request.target && request.target.thread_id) {
    candidates = activeThreads.filter((thread) => String(thread.id) === String(request.target.thread_id));
  } else if (operation === 'discord.fetch_recent_summary' && request.target && request.target.channel_id) {
    candidates = candidates.filter((channel) => String(channel.id) === String(request.target.channel_id));
  } else if (operation === 'discord.fetch_recent_summary' && request.target && request.target.thread_id) {
    candidates = activeThreads.filter((thread) => String(thread.id) === String(request.target.thread_id));
  } else if (operation === 'discord.fetch_messages' || operation === 'discord.fetch_thread_messages') {
    return fail('discord_read_target_required');
  }

  if (includeThreads && operation !== 'discord.fetch_messages' && operation !== 'discord.fetch_thread_messages') {
    for (const thread of activeThreads) {
      if (readableTypes.has(thread.type) && candidates.length < maxChannels) {
        candidates.push(thread);
        channelById.set(String(thread.id), thread);
      }
    }
  }

  if (operation === 'discord.list_channels') {
    const names = channels.slice(0, maxChannels).map((channel) => '#' + safeText(channel.name, 40)).filter(Boolean);
    return [{
      json: {
        ok: true,
        reason: 'ok',
        safe_reply: 'Discord のチャンネル一覧を確認しました。\\n- 対象: ' + names.join(', '),
        results: [{ id: request.id || 'discord_read', workflow_key: 'discord.server_read', operation, status: 'ok', summary: names.join(', ') }],
      },
    }];
  }

  if (operation === 'discord.list_active_threads') {
    const names = activeThreads.slice(0, maxChannels).map((thread) => '#' + safeText(thread.name, 40));
    return [{
      json: {
        ok: true,
        reason: 'ok',
        safe_reply: names.length ? 'Discord の active thread を確認しました。\\n- 対象: ' + names.join(', ') : 'Discord の active thread は見つかりませんでした。',
        results: [{ id: request.id || 'discord_read', workflow_key: 'discord.server_read', operation, status: 'ok', summary: names.join(', ') }],
      },
    }];
  }

  const messages = [];
  const failures = [];
  for (const channel of candidates) {
    try {
      const fetched = await discordRequest('/channels/' + channel.id + '/messages?limit=' + messagesPerChannel);
      for (const message of fetched) {
        const timestamp = Date.parse(message.timestamp || '');
        if (Number.isFinite(timestamp) && timestamp >= sinceMs) {
          messages.push({
            channel_id: String(channel.id),
            channel_name: safeText(channel.name, 40),
            timestamp,
            content: safeText(message.content, 180),
          });
        }
      }
    } catch (error) {
      failures.push(String(error.code || 'discord_fetch_failed'));
    }
  }

  const channelCounts = new Map();
  const termCounts = new Map();
  const stopWords = new Set(['です', 'ます', 'する', 'した', 'して', 'これ', 'それ', 'ため', 'よう', 'こと', 'さん', 'あり', 'なし', 'openclaw-api']);
  for (const message of messages) {
    channelCounts.set(message.channel_name || message.channel_id, (channelCounts.get(message.channel_name || message.channel_id) || 0) + 1);
    const terms = message.content.match(/[A-Za-z0-9_+#.-]{2,}|[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}ー]{2,}/gu) || [];
    for (const rawTerm of terms) {
      const term = safeText(rawTerm.toLowerCase(), 40);
      if (term && !stopWords.has(term) && term.length >= 2) termCounts.set(term, (termCounts.get(term) || 0) + 1);
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
    '- 対象: ' + candidates.length + ' channel/thread、' + messages.length + ' messages',
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
        id: request.id || 'discord_read',
        workflow_key: 'discord.server_read',
        operation,
        status: 'ok',
        summary: 'channels=' + candidates.length + ', messages=' + messages.length,
      }],
    },
  }];
} catch (error) {
  const reason = String(error.code || 'discord_read_failed').replace(/[^a-z0-9_:-]+/gi, '_').slice(0, 80);
  return fail(reason);
}
`,
    },
    position: [540, 300],
  },
  output: [{ ok: true, safe_reply: 'Discord サーバーの直近投稿を確認しました。', results: [] }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond With Safe Summary',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json }}',
      options: {
        responseCode: 200,
      },
    },
    position: [840, 300],
  },
});

export default workflow('openclaw-discord-read', 'OpenClaw Discord Read')
  .add(webhookTrigger)
  .to(readDiscord)
  .to(respond);
