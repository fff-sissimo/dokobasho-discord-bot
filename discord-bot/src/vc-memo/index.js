const { v4: uuidv4 } = require('uuid');
const sessionManager = require('./session-manager');
const speakerTracker = require('./speaker-tracker');
const draftWriter = require('./draft-writer');
const voiceListener = require('./voice-listener');
const audioProcessor = require('./audio-processor');
const sttClient = require('./stt-client');
const summarizer = require('./summarizer');
const { createRecordingStore } = require('./recording-store');
const logger = require('../logger');

const activeSessionIdsByGuild = new Map();
const lastDraftSessionIdsByGuild = new Map();
const processingSessionIds = new Set();
const recordingStoresBySession = new Map();

function _validateRuntimeConfig(env = process.env) {
  if (!env.VC_MEMO_OPENAI_API_KEY && !env.OPENAI_API_KEY) {
    return { error: 'VC Memo transcription requires VC_MEMO_OPENAI_API_KEY or OPENAI_API_KEY' };
  }
  return { ok: true };
}

function _buildDraftContent(sessionId, summaryData, session) {
  const sessionIdStr = session.id || sessionId;
  const now = new Date();
  const status = 'ドラフト - 人による確認が必要';

  const speakerMap = [];
  for (const label of Object.values(session._speakerLabels || {})) {
    speakerMap.push(`- ${label}`);
  }

  const summary = summaryData.summary || [];
  const conversationFlow = summaryData.conversationFlow || [];
  const detailedNotes = summaryData.detailedNotes || [];
  const decisions = summaryData.decisions || [];
  const todos = summaryData.todos || [];
  const openQuestions = summaryData.openQuestions || [];
  const summaryError = summaryData.summaryError;

  let content = `# VCメモ ドラフト\n\n`;
  content += `**状態:** ${status}\n\n`;
  content += `**セッションID:** ${sessionIdStr}\n\n`;
  content += `**開始:** ${session.createdAt || now.toISOString()}\n\n`;
  content += `**終了:** ${now.toISOString()}\n\n`;
  content += `---\n\n`;

  if (speakerMap.length > 0) {
    content += `## 話者\n\n`;
    content += speakerMap.join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (conversationFlow.length > 0) {
    content += `## 会話の流れ\n\n`;
    content += conversationFlow.map((item) => `- ${item}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (detailedNotes.length > 0) {
    content += `## 詳細メモ\n\n`;
    content += detailedNotes.map((item) => `- ${item}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (summary.length > 0) {
    content += `## 要点\n\n`;
    content += summary.map((s) => `- ${s}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (decisions.length > 0) {
    content += `## 決定事項\n\n`;
    content += decisions.map((d) => `- ${d}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (todos.length > 0) {
    content += `## 対応事項\n\n`;
    content += todos.map((t) => `- ${t}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (openQuestions.length > 0) {
    content += `## 未解決の確認事項\n\n`;
    content += openQuestions.map((q) => `- ${q}`).join('\n') + '\n\n';
    content += `---\n\n`;
  }

  if (summaryError) {
    content += `## 要約処理の状態\n\n`;
    content += `要約の生成に失敗しました。全文文字起こしは transcript.txt に保存されています。\n\n`;
    content += `---\n\n`;
  }

  return content;
}

function _getPacketBuffersTotalBytes(packetBuffers) {
  return packetBuffers.reduce((sum, buffer) => sum + (buffer.byteLength || buffer.length || 0), 0);
}

function _copySpeakingBufferTimeline() {
  if (typeof voiceListener.getSpeakingBufferTimeline !== 'function') {
    return [];
  }

  return voiceListener.getSpeakingBufferTimeline()
    .map((event) => ({
      userId: event?.userId,
      packetBuffers: [...(event?.packetBuffers || [])],
    }))
    .filter((event) => event.userId && event.packetBuffers.length > 0);
}

function _coalesceSpeakingBufferTimeline(timeline) {
  const segments = [];

  for (const event of timeline) {
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.userId === event.userId) {
      lastSegment.packetBuffers.push(...event.packetBuffers);
      continue;
    }

    segments.push({
      userId: event.userId,
      packetBuffers: [...event.packetBuffers],
    });
  }

  return segments;
}

async function start(client, options = {}) {
  if (!sessionManager.checkFeatureEnabled()) {
    return { error: 'VC Memo is not enabled (set VC_MEMO_ENABLED=true)' };
  }

  const runtimeConfig = _validateRuntimeConfig();
  if (runtimeConfig.error) {
    return { error: runtimeConfig.error };
  }

  const { guildId, channelId } = options;
  if (!guildId || !channelId) {
    return { error: 'guildId and channelId are required' };
  }
  if (options.canManageGuild !== true) {
    return { error: 'Not authorized to start VC Memo' };
  }

  const session = sessionManager.createSession(guildId, channelId, {
    mode: options.mode,
    stt: options.stt,
    ownerUserId: options.ownerUserId,
    consentConfirmed: options.consentConfirmed,
  });
  if (session.error) {
    return { error: session.error };
  }

  const recordingStore = createRecordingStore({
    rootDir: process.env.VC_MEMO_CACHE_DIR || '.cache/vc-memo-drafts',
    sessionId: session.id,
  });
  recordingStoresBySession.set(session.id, recordingStore);
  if (typeof audioProcessor.setRecordingStore === 'function') {
    audioProcessor.setRecordingStore(guildId, recordingStore);
  }

  try {
    const connection = await voiceListener.voiceJoinChannel(channelId, guildId, client);

    speakerTracker.reset();

    voiceListener.onSpeakingStart((userId) => {
      const speakerId = speakerTracker.getSpeakerId(userId);
      logger.info({ speakerId, sessionId: session.id }, '[vc-memo] speaker started');
    });

    voiceListener.onSpeakingEnd((userId) => {
      const speakerId = speakerTracker.getSpeakerId(userId);
      logger.info({ speakerId, sessionId: session.id }, '[vc-memo] speaker ended');
    });

    voiceListener.onVoiceConnectionReady(connection, channelId, guildId);

    sessionManager.updateState(session.id, 'ACTIVE');
    activeSessionIdsByGuild.set(guildId, session.id);
    lastDraftSessionIdsByGuild.delete(guildId);

    logger.info({ sessionId: session.id }, '[vc-memo] recording started');
    return session;
  } catch (err) {
    logger.error({ err: err.message }, '[vc-memo] failed to join voice channel');
    voiceListener.leaveVoiceChannel();
    if (typeof audioProcessor.clearRecordingStore === 'function') {
      audioProcessor.clearRecordingStore(guildId);
    }
    recordingStoresBySession.delete(session.id);
    sessionManager.updateState(session.id, 'IDLE');
    sessionManager.deleteSession(session.id);
    return { error: `Failed to join voice channel: ${err.message}` };
  }
}

async function stop(sessionId, controller = {}) {
  if (!sessionManager.canControlSession(sessionId, controller)) {
    return { error: 'Not authorized to control this session' };
  }
  if (processingSessionIds.has(sessionId)) {
    return { error: 'Already processing a session' };
  }
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'Session not found' };
  }
  if (activeSessionIdsByGuild.get(session.guildId) !== sessionId) {
    return { error: 'No active session to stop' };
  }

  processingSessionIds.add(sessionId);

  try {
    sessionManager.updateState(sessionId, 'PROCESSING');

    const transcriptChunks = [];
    const speakerTranscripts = {};
    const speakingBuffers = new Map();
    for (const [userId, packetBuffers] of voiceListener.getSpeakingBuffers().entries()) {
      speakingBuffers.set(userId, [...packetBuffers]);
    }
    const speakingBufferTimeline = _copySpeakingBufferTimeline();
    const recordingStore = recordingStoresBySession.get(sessionId);

    voiceListener.leaveVoiceChannel();

    const storedUsers = recordingStore ? recordingStore.listUsers() : [];
    const speakingEvents = storedUsers.length > 0
      ? storedUsers.map((userId) => ({ userId, packetBuffers: null }))
      : speakingBufferTimeline.length > 0
        ? _coalesceSpeakingBufferTimeline(speakingBufferTimeline)
        : Array.from(speakingBuffers.entries()).map(([userId, packetBuffers]) => ({ userId, packetBuffers }));

    for (const { userId, packetBuffers } of speakingEvents) {
      if (packetBuffers && _getPacketBuffersTotalBytes(packetBuffers) === 0) continue;

      const speakerLabel = speakerTracker.getSpeakerLabel(userId);
      if (!speakerTranscripts[userId]) {
        speakerTranscripts[userId] = '';
      }

      try {
        const wavBuffers = recordingStore && packetBuffers === null
          ? recordingStore.readWavChunks(userId, process.env.VC_MEMO_STT_MAX_WAV_BYTES)
          : audioProcessor.getDecodedWavChunksForUser(userId, packetBuffers);
        let chunkIndex = 0;
        for (const wavBuffer of wavBuffers) {
          chunkIndex += 1;
          if (!wavBuffer || wavBuffer.length === 0) continue;

          logger.info(
            { speakerLabel, chunkIndex, wavBytes: wavBuffer.length },
            '[vc-memo] transcribing audio chunk'
          );

          const text = await sttClient.transcribe(wavBuffer);
          if (text && text.trim()) {
            const chunk = `${speakerLabel}: ${text}\n`;
            transcriptChunks.push(chunk);
            speakerTranscripts[userId] += chunk;
          }
        }
      } catch (err) {
        logger.error({ speakerLabel, err: err.message }, '[vc-memo] transcription failed for speaking event');
      }
    }

    voiceListener.clearSpeakingBuffers();

    const fullTranscript = transcriptChunks.join('');
    if (recordingStore) {
      recordingStore.writeTranscript(fullTranscript);
    }

    session._speakerLabels = {};
    for (const [userId] of speakingBuffers.entries()) {
      session._speakerLabels[userId] = speakerTracker.getSpeakerLabel(userId);
    }
    for (const { userId } of speakingBufferTimeline) {
      session._speakerLabels[userId] = speakerTracker.getSpeakerLabel(userId);
    }
    for (const userId of storedUsers) {
      session._speakerLabels[userId] = speakerTracker.getSpeakerLabel(userId);
    }

    let summaryData;
    try {
      summaryData = await summarizer.summarize(fullTranscript, Object.values(session._speakerLabels));
    } catch (err) {
      logger.error({ err: err.message }, '[vc-memo] summarization failed, saving empty draft sections');
      summaryData = {
        summary: [],
        conversationFlow: [],
        detailedNotes: [],
        decisions: [],
        todos: [],
        openQuestions: [],
        summaryError: true,
      };
    }

    const draftContent = _buildDraftContent(sessionId, summaryData, session);
    draftWriter.writeDraft(sessionId, draftContent);

    sessionManager.updateState(sessionId, 'DRAFT_READY');
    lastDraftSessionIdsByGuild.set(session.guildId, sessionId);

    logger.info({ sessionId }, '[vc-memo] processing complete, draft ready');
    return { draft: draftContent, sessionId };
  } catch (err) {
    logger.error({ err: err.message }, '[vc-memo] error during processing');
    voiceListener.leaveVoiceChannel();
    sessionManager.updateState(sessionId, 'IDLE');
    return { error: `Processing failed: ${err.message}` };
  } finally {
    processingSessionIds.delete(sessionId);
    activeSessionIdsByGuild.delete(session.guildId);
    if (typeof audioProcessor.clearRecordingStore === 'function') {
      audioProcessor.clearRecordingStore(session.guildId);
    }
    recordingStoresBySession.delete(sessionId);
  }
}

function getStatus(sessionId) {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'Session not found' };
  }
  return {
    sessionId: session.id,
    state: session.state,
    guildId: session.guildId,
    channelId: session.channelId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function discard(sessionId, controller = {}) {
  if (!sessionId) {
    return { error: 'Session not found' };
  }
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'Session not found' };
  }
  if (!sessionManager.canControlSession(sessionId, controller)) {
    return { error: 'Not authorized to control this session' };
  }
  if (activeSessionIdsByGuild.get(session.guildId) === sessionId) {
    voiceListener.leaveVoiceChannel();
  }
  const draftDeleted = draftWriter.deleteDraft(sessionId);
  sessionManager.updateState(sessionId, 'IDLE');
  sessionManager.deleteSession(sessionId);
  activeSessionIdsByGuild.delete(session.guildId);
  if (lastDraftSessionIdsByGuild.get(session.guildId) === sessionId) {
    lastDraftSessionIdsByGuild.delete(session.guildId);
  }
  return { discarded: true, draftDeleted };
}

module.exports = {
  start,
  stop,
  getStatus,
  discard,
  getActiveSession: (guildId) => guildId
    ? (activeSessionIdsByGuild.get(guildId) || null)
    : sessionManager.getActiveSessionId(),
  getCurrentSession: (guildId) => {
    if (guildId) {
      return activeSessionIdsByGuild.get(guildId) || lastDraftSessionIdsByGuild.get(guildId) || null;
    }
    return sessionManager.getActiveSessionId();
  },
  checkFeatureEnabled: sessionManager.checkFeatureEnabled,
  _validateRuntimeConfig,
};
