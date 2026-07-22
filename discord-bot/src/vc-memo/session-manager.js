const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');

const STATES = {
  IDLE: 'IDLE',
  JOINING: 'JOINING',
  ACTIVE: 'ACTIVE',
  PROCESSING: 'PROCESSING',
  DRAFT_READY: 'DRAFT_READY',
};

const sessions = new Map();
const activeSessionIdsByGuild = new Map();

function getAllowlist(guildIds, channelIds) {
  const guildSet = new Set((guildIds || '').split(',').map((id) => id.trim()).filter(Boolean));
  const channelSet = new Set((channelIds || '').split(',').map((id) => id.trim()).filter(Boolean));
  return { guildSet, channelSet };
}

function checkFeatureEnabled() {
  return process.env.VC_MEMO_ENABLED === 'true';
}

function validateGuildChannel(guildId, channelId) {
  if (!checkFeatureEnabled()) return { valid: false, reason: 'Feature is disabled' };
  const { guildSet, channelSet } = getAllowlist(
    process.env.VC_MEMO_ALLOWED_GUILD_IDS,
    process.env.VC_MEMO_ALLOWED_CHANNEL_IDS
  );
  if (guildSet.size === 0 || channelSet.size === 0) {
    return { valid: false, reason: 'VC Memo requires explicit guild and channel allowlists' };
  }
  if (guildSet.size > 0 && !guildSet.has(guildId)) {
    return { valid: false, reason: `Guild ${guildId} is not in allowlist` };
  }
  if (channelSet.size > 0 && !channelSet.has(channelId)) {
    return { valid: false, reason: `Channel ${channelId} is not in allowlist` };
  }
  return { valid: true };
}

function normalizeSessionOptions(optionsOrMode, stt, consentConfirmed) {
  if (optionsOrMode && typeof optionsOrMode === 'object') {
    return { ...optionsOrMode };
  }
  return {
    mode: optionsOrMode,
    stt,
    consentConfirmed,
  };
}

function createSession(guildId, channelId, optionsOrMode, stt, consentConfirmed) {
  if (!checkFeatureEnabled()) return { error: 'Feature is disabled' };
  const guildChannelCheck = validateGuildChannel(guildId, channelId);
  if (!guildChannelCheck.valid) return { error: guildChannelCheck.reason };

  const options = normalizeSessionOptions(optionsOrMode, stt, consentConfirmed);
  if (options.consentConfirmed !== true) {
    return { error: 'Recording consent is required' };
  }
  if (activeSessionIdsByGuild.has(guildId)) {
    return { error: 'Another session is already active in this guild' };
  }

  const sessionId = uuidv4();
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    guildId,
    channelId,
    ownerUserId: options.ownerUserId || null,
    mode: options.mode || 'single',
    stt: options.stt || 'whisper',
    consentConfirmed: true,
    state: STATES.JOINING,
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sessionId, session);
  activeSessionIdsByGuild.set(guildId, sessionId);
  logger.info({ sessionId, guildId, channelId, mode: session.mode, stt: session.stt }, '[vc-memo] session created');
  return session;
}

function updateState(sessionId, newState) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  const validTransitions = {
    IDLE: ['JOINING'],
    JOINING: ['ACTIVE', 'IDLE'],
    ACTIVE: ['PROCESSING', 'IDLE'],
    PROCESSING: ['DRAFT_READY', 'IDLE'],
    DRAFT_READY: ['IDLE'],
  };
  const allowed = validTransitions[session.state] || [];
  if (!allowed.includes(newState)) {
    return { error: `Invalid state transition: ${session.state} -> ${newState}` };
  }
  const oldState = session.state;
  session.state = newState;
  session.updatedAt = new Date().toISOString();
  if ([STATES.IDLE, STATES.DRAFT_READY].includes(newState)) {
    if (activeSessionIdsByGuild.get(session.guildId) === sessionId) {
      activeSessionIdsByGuild.delete(session.guildId);
    }
  } else if (newState === STATES.JOINING) {
    activeSessionIdsByGuild.set(session.guildId, sessionId);
  }
  logger.info({ sessionId, from: oldState, to: newState }, '[vc-memo] state updated');
  return { session: { ...session } };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  sessions.delete(sessionId);
  if (activeSessionIdsByGuild.get(session.guildId) === sessionId) {
    activeSessionIdsByGuild.delete(session.guildId);
  }
  logger.info({ sessionId }, '[vc-memo] session deleted');
  return { deleted: true };
}

function getActiveSessionId(guildId) {
  if (guildId) return activeSessionIdsByGuild.get(guildId) || null;
  if (activeSessionIdsByGuild.size !== 1) return null;
  return activeSessionIdsByGuild.values().next().value || null;
}

function hasActiveSession(guildId) {
  return guildId ? activeSessionIdsByGuild.has(guildId) : activeSessionIdsByGuild.size > 0;
}

function canControlSession(sessionId, { userId, canManageGuild = false } = {}) {
  const session = getSession(sessionId);
  if (!session || !userId) return false;
  return canManageGuild || session.ownerUserId === userId;
}

function reset() {
  sessions.clear();
  activeSessionIdsByGuild.clear();
}

module.exports = {
  STATES,
  canControlSession,
  checkFeatureEnabled,
  createSession,
  deleteSession,
  getActiveSessionId,
  getSession,
  hasActiveSession,
  reset,
  updateState,
  validateGuildChannel,
};
