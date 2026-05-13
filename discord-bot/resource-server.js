'use strict';

const http = require('node:http');
const { v4: uuidv4 } = require('uuid');
const chrono = require('chrono-node');

const logger = require('./src/logger');
const {
  getSheetsClient,
  getReminderByKey,
  addReminder,
  listReminders,
  deleteReminderById,
} = require('./src/google-sheets');
const { resolveTimezone, adjustDateForTimezone } = require('./src/timezone');
const { MESSAGES } = require('./src/message-templates');
const { generateReminderKey } = require('./src/reminder-key');
const { normalizeTimeInput } = require('./src/time-input');

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8790;
const DEFAULT_PATH_PREFIX = '/internal/remind';
const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_PREVIEW_LENGTH = 30;
const MAX_KEY_ATTEMPTS = 5;
const VALID_SCOPES = new Set(['user', 'channel', 'server']);
const VALID_VISIBILITY = new Set(['ephemeral', 'public']);
const VALID_RECURRING = new Set(['off', 'daily', 'weekly', 'monthly']);

const normalizeString = (value) => String(value ?? '').trim();

const parsePositiveInt = (raw, fallback) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeScope = (scope) => {
  const normalized = normalizeString(scope || 'user') || 'user';
  if (!VALID_SCOPES.has(normalized)) {
    throw Object.assign(new Error('invalid scope'), { statusCode: 400, code: 'invalid_scope' });
  }
  return normalized;
};

const normalizeVisibility = (visibility, scope) => {
  const normalized = normalizeString(visibility || (scope === 'user' ? 'ephemeral' : 'public'));
  if (!VALID_VISIBILITY.has(normalized)) {
    throw Object.assign(new Error('invalid visibility'), { statusCode: 400, code: 'invalid_visibility' });
  }
  return normalized;
};

const normalizeRecurring = (recurring) => {
  const normalized = normalizeString(recurring || 'off') || 'off';
  if (!VALID_RECURRING.has(normalized)) {
    throw Object.assign(new Error('invalid recurring'), { statusCode: 400, code: 'invalid_recurring' });
  }
  return normalized;
};

const requireField = (body, field) => {
  const value = normalizeString(body[field]);
  if (!value) {
    throw Object.assign(new Error(`missing ${field}`), { statusCode: 400, code: `missing_${field}` });
  }
  return value;
};

async function generateUniqueReminderKey(scope) {
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const candidate = generateReminderKey();
    const existing = await getReminderByKey(candidate, scope);
    if (!existing) return candidate;
  }
  throw Object.assign(new Error('Failed to generate unique reminder key.'), {
    statusCode: 500,
    code: 'key_generation_failed',
  });
}

const buildDiscordTimestamp = (date, format = 'F') => `<t:${Math.floor(date.getTime() / 1000)}:${format}>`;

async function addReminderFromPayload(body, { now = () => new Date() } = {}) {
  await getSheetsClient();

  const rawTime = requireField(body, 'time');
  const content = requireField(body, 'content');
  const userId = requireField(body, 'user_id');
  const guildId = normalizeString(body.guild_id);
  const channelId = normalizeString(body.channel_id);
  const scope = normalizeScope(body.scope);
  const visibility = normalizeVisibility(body.visibility, scope);
  const recurring = normalizeRecurring(body.recurring);
  const isAdmin = parseBoolean(body.is_admin, false);
  const targetChannelId = normalizeString(body.target_channel_id || body.channel_id);
  const referenceInstant = body.reference_instant ? new Date(body.reference_instant) : now();

  if (Number.isNaN(referenceInstant.getTime())) {
    throw Object.assign(new Error('invalid reference_instant'), { statusCode: 400, code: 'invalid_reference_instant' });
  }
  if (scope === 'server' && !isAdmin) {
    return { ok: false, status: 'rejected', code: 'admin_required', reply_content: MESSAGES.responses.adminRequiredForCreate };
  }
  if (scope === 'server' && !targetChannelId) {
    return { ok: false, status: 'rejected', code: 'channel_required', reply_content: MESSAGES.responses.channelRequiredForServerScope };
  }
  if (scope === 'channel' && !channelId) {
    throw Object.assign(new Error('missing channel_id'), { statusCode: 400, code: 'missing_channel_id' });
  }
  if (scope === 'server' && !guildId) {
    throw Object.assign(new Error('missing guild_id'), { statusCode: 400, code: 'missing_guild_id' });
  }

  const resolvedTimezone = resolveTimezone(body.timezone, referenceInstant);
  if (resolvedTimezone.error) {
    return { ok: false, status: 'rejected', code: 'invalid_timezone', reply_content: resolvedTimezone.error };
  }

  let parsedDate = chrono.parseDate(
    normalizeTimeInput(rawTime),
    { instant: referenceInstant, timezone: resolvedTimezone.offset },
    { forwardDate: true }
  );
  if (!parsedDate) {
    return { ok: false, status: 'rejected', code: 'invalid_time', reply_content: MESSAGES.errors.invalidTime };
  }
  if (resolvedTimezone.source === 'iana') {
    parsedDate = adjustDateForTimezone(parsedDate, resolvedTimezone.label, resolvedTimezone.offset);
  }

  let key;
  try {
    key = await generateUniqueReminderKey(scope);
  } catch (error) {
    if (error.code === 'key_generation_failed') {
      return { ok: false, status: 'rejected', code: 'key_generation_failed', reply_content: MESSAGES.errors.keyGenerationFailed };
    }
    throw error;
  }

  const reminder = {
    id: uuidv4(),
    key,
    content,
    scope,
    guild_id: guildId,
    channel_id: scope === 'server' ? targetChannelId : (scope === 'channel' ? channelId : ''),
    user_id: userId,
    notify_time_utc: parsedDate.toISOString(),
    timezone: resolvedTimezone.label,
    recurring,
    visibility,
    created_by: userId,
    created_at: now().toISOString(),
    status: 'pending',
    last_sent: '',
    retry_count: 0,
    metadata: JSON.stringify({ source: 'resource-server' }),
  };

  await addReminder(reminder);
  const displayDate = buildDiscordTimestamp(parsedDate, 'F');
  return {
    ok: true,
    status: 'created',
    reminder,
    reply_content: MESSAGES.responses.created(key, displayDate),
  };
}

async function listRemindersFromPayload(body) {
  await getSheetsClient();

  const scope = normalizeScope(body.scope);
  const userId = normalizeString(body.user_id);
  const channelId = normalizeString(body.channel_id);
  const guildId = normalizeString(body.guild_id);
  const query = normalizeString(body.query);
  const limit = parsePositiveInt(body.limit, 50);

  if (scope === 'user' && !userId) {
    throw Object.assign(new Error('missing user_id'), { statusCode: 400, code: 'missing_user_id' });
  }
  if (scope === 'channel' && !channelId) {
    throw Object.assign(new Error('missing channel_id'), { statusCode: 400, code: 'missing_channel_id' });
  }
  if (scope === 'server' && !guildId) {
    throw Object.assign(new Error('missing guild_id'), { statusCode: 400, code: 'missing_guild_id' });
  }

  const reminders = await listReminders(scope, { userId, channelId, guildId });
  if (reminders.length === 0) {
    return { ok: true, status: 'empty', reminders: [], reply_content: MESSAGES.responses.listEmpty };
  }

  const filtered = query
    ? reminders.filter((r) => normalizeString(r.key).includes(query) || normalizeString(r.content).includes(query))
    : reminders;
  const displayedReminders = filtered.slice(0, limit);
  const listContent = displayedReminders.map((r) => {
    const notifyTime = new Date(r.notify_time_utc);
    const displayDate = Number.isNaN(notifyTime.getTime()) ? '(通知時刻不明)' : buildDiscordTimestamp(notifyTime, 'R');
    const contentPreview = normalizeString(r.content).substring(0, CONTENT_PREVIEW_LENGTH);
    return MESSAGES.responses.listItem(r.key, contentPreview, displayDate);
  }).join('\n');
  const replyContent = filtered.length === 0
    ? MESSAGES.responses.listEmpty
    : MESSAGES.responses.listHeader(scope, filtered.length, displayedReminders.length, listContent);

  return {
    ok: true,
    status: 'listed',
    reminders: displayedReminders,
    total: filtered.length,
    displayed: displayedReminders.length,
    reply_content: replyContent,
  };
}

async function deleteReminderFromPayload(body) {
  await getSheetsClient();

  const key = requireField(body, 'key');
  const scope = normalizeScope(body.scope);
  const isAdmin = parseBoolean(body.is_admin, false);

  if (scope === 'server' && !isAdmin) {
    return { ok: false, status: 'rejected', code: 'admin_required', reply_content: MESSAGES.responses.adminRequiredForDelete };
  }

  const reminder = await getReminderByKey(key, scope);
  if (!reminder) {
    return { ok: false, status: 'not_found', code: 'not_found', reply_content: MESSAGES.responses.notFound };
  }

  const deleteResult = await deleteReminderById(reminder.id);
  if (!deleteResult || deleteResult.alreadyDeleted) {
    return { ok: false, status: 'already_deleted', code: 'already_deleted', reply_content: MESSAGES.responses.alreadyDeleted };
  }

  return {
    ok: true,
    status: 'deleted',
    key,
    reminder_id: reminder.id,
    reply_content: MESSAGES.responses.deleteSuccess(key),
  };
}

const readJsonBody = (req, maxBytes = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      reject(Object.assign(new Error('payload too large'), { statusCode: 413, code: 'payload_too_large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!raw) return resolve({});
    try {
      resolve(JSON.parse(raw));
    } catch (error) {
      reject(Object.assign(new Error('invalid json'), { statusCode: 400, code: 'invalid_json' }));
    }
  });
  req.on('error', reject);
});

const sendJson = (res, statusCode, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const isAuthorized = (req, token) => {
  if (!token) return true;
  return normalizeString(req.headers['x-resource-api-token']) === token;
};

function createResourceServer(options = {}) {
  const token = normalizeString(options.token ?? process.env.RESOURCE_API_TOKEN);
  const pathPrefix = normalizeString(options.pathPrefix || process.env.RESOURCE_API_PATH_PREFIX || DEFAULT_PATH_PREFIX).replace(/\/$/, '');
  const maxBodyBytes = parsePositiveInt(options.maxBodyBytes || process.env.RESOURCE_API_MAX_BODY_BYTES, MAX_BODY_BYTES);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!url.pathname.startsWith(pathPrefix)) {
        sendJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      const body = await readJsonBody(req, maxBodyBytes);
      let result;
      if (url.pathname === `${pathPrefix}/add`) {
        result = await addReminderFromPayload(body, options);
      } else if (url.pathname === `${pathPrefix}/list`) {
        result = await listRemindersFromPayload(body);
      } else if (url.pathname === `${pathPrefix}/delete`) {
        result = await deleteReminderFromPayload(body);
      } else {
        sendJson(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        logger.error({ err: error }, '[resource-server] request failed');
      }
      sendJson(res, statusCode, {
        ok: false,
        error: error.code || 'internal_error',
        message: statusCode >= 500 ? 'internal error' : error.message,
      });
    }
  });

  return {
    server,
    start: () => new Promise((resolve, reject) => {
      const port = options.port ?? parsePositiveInt(process.env.RESOURCE_API_PORT, DEFAULT_PORT);
      const host = options.host ?? process.env.RESOURCE_API_HOST ?? DEFAULT_HOST;
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        const runtime = {
          server,
          port: typeof address === 'object' && address ? address.port : port,
          host,
          stop: () => new Promise((stopResolve, stopReject) => {
            server.close((error) => (error ? stopReject(error) : stopResolve()));
          }),
        };
        resolve(runtime);
      });
    }),
  };
}

if (require.main === module) {
  const runtime = createResourceServer();
  runtime.start().then(({ port, host }) => {
    if (!process.env.RESOURCE_API_TOKEN) {
      logger.warn('[resource-server] RESOURCE_API_TOKEN is not set; internal API accepts unauthenticated requests.');
    }
    logger.info(`[resource-server] listening on ${host}:${port}`);
  }).catch((error) => {
    logger.error({ err: error }, '[resource-server] failed to start');
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info({ signal }, '[resource-server] shutdown requested');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  createResourceServer,
  addReminderFromPayload,
  listRemindersFromPayload,
  deleteReminderFromPayload,
};
