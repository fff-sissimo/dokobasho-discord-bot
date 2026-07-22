const {
  VoiceConnectionStatus,
  VoiceConnection,
  EndBehaviorType,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { ChannelType, Events } = require('discord.js');
const logger = require('../logger');

let voiceConnection = null;
let subscriber = null;
let speakStartCallback = null;
let speakEndCallback = null;
const speakingBuffers = new Map();
const speakingBufferTimeline = [];
const activeSubscriptions = new Map();
let gatewayEventListeners = [];
let receiverSpeakingListeners = [];
let activeGuildId = null;

const DIAGNOSTIC_TAIL_LIMIT = 20;

function _pushDiagnosticTail(tail, value) {
  tail.push(value);
  if (tail.length > DIAGNOSTIC_TAIL_LIMIT) {
    tail.shift();
  }
}

function _summarizeVoiceDebugMessage(message) {
  const text = String(message || '');
  const summarizeFreeText = (value) => (
    /token|session[_-]?id|sessionId|secret[_-]?key|secretKey/i.test(value)
      ? 'redacted message'
      : value.slice(0, 160)
  );

  const stateChangeMatch = text.match(/^((?:\[[A-Z]+\]\s+)*)state change:/);
  if (stateChangeMatch) {
    const prefix = stateChangeMatch[1].trim();
    return prefix ? `${prefix} state change` : 'state change';
  }

  const packetMatch = text.match(/^((?:\[[A-Z]+\]\s+)*)(<<|>>)\s+(.+)$/);
  if (packetMatch) {
    try {
      const packet = JSON.parse(packetMatch[3]);
      const op = packet?.op ?? 'unknown';
      const prefix = packetMatch[1].trim();
      return prefix ? `${prefix} ${packetMatch[2]} op=${op}` : `${packetMatch[2]} op=${op}`;
    } catch (_) {
      const prefix = packetMatch[1].trim();
      return prefix ? `${prefix} ${packetMatch[2]} unparseable` : `${packetMatch[2]} unparseable`;
    }
  }

  if (text.startsWith('[NW]')) {
    return '[NW] message';
  }
  if (text.startsWith('[UDP]')) {
    return summarizeFreeText(text);
  }
  if (text.startsWith('[DAVE]')) {
    return '[DAVE] message';
  }
  if (text.startsWith('[WS]')) {
    return '[WS] message';
  }

  return summarizeFreeText(text);
}

function _defer(callback) {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function _addEmitterListener(emitter, event, handler) {
  if (!emitter || typeof emitter.on !== 'function') {
    return false;
  }

  emitter.on(event, handler);
  receiverSpeakingListeners.push([emitter, event, handler]);
  return true;
}

function _cleanUpGatewayListeners() {
  for (const listener of gatewayEventListeners) {
    try {
      const [clientRef, event, handler] = listener.length === 3
        ? listener
        : [voiceConnection?.client, listener[0], listener[1]];
      if (clientRef && typeof clientRef.off === 'function') {
        clientRef.off(event, handler);
      } else if (clientRef && typeof clientRef.removeListener === 'function') {
        clientRef.removeListener(event, handler);
      }
    } catch (_) {
      // ignore
    }
  }
  gatewayEventListeners = [];
}

function _maybeConfigureNetworking(connection) {
  if (
    connection?.state?.status === VoiceConnectionStatus.Signalling &&
    connection?.packets?.server &&
    connection?.packets?.state &&
    typeof connection.configureNetworking === 'function'
  ) {
    logger.info('[vc-memo/voice] configuring networking after receiving both voice gateway packets');
    connection.configureNetworking();
  }
}

function _describeVoiceJoinState(connection, client, guildId, diagnostics = {}) {
  const statePacket = connection?.packets?.state;
  const serverPacket = connection?.packets?.server;
  const guild = client?.guilds?.cache?.get?.(guildId);
  const networking = connection?.state?.networking;
  const networkingState = networking?.state;
  const networkingWs = networkingState?.ws?.ws || networkingState?.ws;
  const networkingUdp = networkingState?.udp;
  return {
    status: connection?.state?.status,
    reason: connection?.state?.reason,
    closeCode: connection?.state?.closeCode,
    rejoinAttempts: connection?.rejoinAttempts,
    hasServerPacket: Boolean(serverPacket),
    serverEndpoint: serverPacket?.endpoint || null,
    hasStatePacket: Boolean(statePacket),
    stateSessionIdPresent: Boolean(statePacket?.session_id),
    stateChannelId: statePacket?.channel_id || null,
    adapterRegistered: Boolean(client?.voice?.adapters?.has?.(guildId)),
    guildShardStatus: guild?.shard?.status,
    clientWsStatus: client?.ws?.status,
    hasNetworking: Boolean(networking),
    networkingCode: networkingState?.code ?? null,
    networkingWsReadyState: networkingWs?.readyState ?? null,
    networkingUdpPresent: Boolean(networkingUdp),
    voiceDebugTail: diagnostics.voiceDebugTail || [],
  };
}

function _attachRawVoiceGatewayFallback(client, guildId, channelId) {
  if (!client || typeof client.on !== 'function') {
    return;
  }

  const rawEvent = Events.Raw || 'raw';
  const rawVoiceGatewayHandler = (packet) => {
    const eventName = packet?.t;
    const data = packet?.d;
    if (
      !data ||
      data.guild_id !== guildId ||
      (eventName !== 'VOICE_SERVER_UPDATE' && eventName !== 'VOICE_STATE_UPDATE')
    ) {
      return;
    }

    _defer(() => {
      const activeConnection = voiceConnection;
      if (!activeConnection || activeConnection.state?.status === VoiceConnectionStatus.Destroyed) {
        return;
      }

      const adapterMethods = client.voice?.adapters?.get?.(guildId);
      if (!adapterMethods) {
        return;
      }

      let forwardedPacket = false;

      if (
        eventName === 'VOICE_SERVER_UPDATE' &&
        !activeConnection.packets?.server &&
        typeof adapterMethods.onVoiceServerUpdate === 'function'
      ) {
        logger.warn({ guildId }, '[vc-memo/voice] forwarding missing raw VOICE_SERVER_UPDATE to voice adapter');
        adapterMethods.onVoiceServerUpdate(data);
        forwardedPacket = true;
      }

      if (
        eventName === 'VOICE_STATE_UPDATE' &&
        data.user_id === client.user?.id &&
        data.channel_id === channelId &&
        data.session_id &&
        !activeConnection.packets?.state &&
        typeof adapterMethods.onVoiceStateUpdate === 'function'
      ) {
        logger.warn({ guildId }, '[vc-memo/voice] forwarding missing raw VOICE_STATE_UPDATE to voice adapter');
        adapterMethods.onVoiceStateUpdate(data);
        forwardedPacket = true;
      }

      if (forwardedPacket) {
        _maybeConfigureNetworking(activeConnection);
      }
    });
  };

  client.on(rawEvent, rawVoiceGatewayHandler);
  gatewayEventListeners.push([client, rawEvent, rawVoiceGatewayHandler]);
}

function _cleanUpReceiverSpeakingListeners() {
  for (const [speaking, event, handler] of receiverSpeakingListeners) {
    try {
      if (typeof speaking.off === 'function') {
        speaking.off(event, handler);
      } else if (typeof speaking.removeListener === 'function') {
        speaking.removeListener(event, handler);
      }
    } catch (_) {
      // ignore
    }
  }
  receiverSpeakingListeners = [];
}

function voiceJoinChannel(channelId, guildId, client) {
  return new Promise((resolve, reject) => {
    try {
      const channel = client.channels.cache.get(channelId);
      if (!channel) {
        reject(new Error(`Voice channel ${channelId} not found`));
        return;
      }

      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.Stage) {
        reject(new Error(`Channel ${channelId} is not a voice channel (type=${channel.type}, name="${channel.name}")`));
        return;
      }

      logger.info(
        { channelId, guildId, channelName: channel.name, channelType: channel.type, channelConstructor: channel.constructor.name, channelGuild: channel.guild?.name, channelGuildId: channel.guild?.id },
        '[vc-memo/voice] attempting to join voice channel'
      );

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        reject(new Error(`Guild ${guildId} not found`));
        return;
      }
      if (typeof guild.voiceAdapterCreator !== 'function') {
        reject(new Error(`Guild ${guildId} voiceAdapterCreator is not a function (type=${typeof guild.voiceAdapterCreator})`));
        return;
      }
      _attachRawVoiceGatewayFallback(client, guildId, channelId);

      voiceConnection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
        debug: true,
      });
      logger.info({
        channelId,
        voiceConnectionType: typeof voiceConnection,
        voiceConnectionState: _describeVoiceJoinState(voiceConnection, client, guildId),
      }, '[vc-memo/voice] joinVoiceChannel() result');

      if (!voiceConnection || typeof voiceConnection.on !== 'function') {
        reject(new Error('Failed to create voice connection'));
        voiceConnection = null;
        _cleanUpGatewayListeners();
        return;
      }

      if (voiceConnection && typeof voiceConnection.catch === 'function') {
        voiceConnection.catch((err) => {
          logger.error({ err: err.message || err }, '[vc-memo/voice] join promise rejected');
        });
      }

      let readyResolved = false;
      let destroyedResolved = false;
      const voiceDebugTail = [];

      const cleanup = ({ clearConnection = false } = {}) => {
        _cleanUpGatewayListeners();
        if (clearConnection) {
          voiceConnection = null;
        }
      };

      const timeoutId = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          destroyedResolved = true;
          logger.warn(
            {
              channelId,
              guildId,
              joinState: _describeVoiceJoinState(voiceConnection, client, guildId, { voiceDebugTail }),
            },
            '[vc-memo/voice] connection timeout diagnostics'
          );
          reject(new Error(`Voice channel join timeout after 30 seconds`));
          logger.warn({ channelId, guildId }, '[vc-memo/voice] connection timeout');
          if (voiceConnection && typeof voiceConnection.destroy === 'function') {
            voiceConnection.destroy();
          }
          cleanup({ clearConnection: true });
        }
      }, 30_000);

      voiceConnection.on(VoiceConnectionStatus.Ready, () => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timeoutId);
          const readyConnection = voiceConnection;
          cleanup();
          logger.info(
            {
              channelId,
              guildId,
              joinState: _describeVoiceJoinState(readyConnection, client, guildId, { voiceDebugTail }),
            },
            '[vc-memo/voice] connection ready'
          );
          resolve(readyConnection);
        }
      });

      voiceConnection.on(VoiceConnectionStatus.Destroyed, () => {
        if (!destroyedResolved) {
          destroyedResolved = true;
          clearTimeout(timeoutId);
          logger.info('[vc-memo/voice] connection destroyed');
        }
        cleanup({ clearConnection: true });
        if (!readyResolved) {
          readyResolved = true;
          reject(new Error('Voice connection destroyed'));
        }
      });

      voiceConnection.on('error', (err) => {
        logger.error({ err: err.message || err }, '[vc-memo/voice] connection error');
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timeoutId);
          cleanup({ clearConnection: true });
          reject(err);
        }
      });

      voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
        logger.info(
          { channelId, guildId },
          '[vc-memo/voice] disconnected'
        );
      });

      voiceConnection.on('debug', (msg) => {
        const summarized = _summarizeVoiceDebugMessage(msg);
        _pushDiagnosticTail(voiceDebugTail, summarized);
        logger.debug(`[vc-memo/voice] ${summarized}`);
      });

      voiceConnection.on('stateChange', (oldState, newState) => {
        logger.info(
          {
            channelId,
            guildId,
            from: oldState?.status,
            to: newState?.status,
            reason: newState?.reason,
            closeCode: newState?.closeCode,
            joinState: _describeVoiceJoinState(voiceConnection, client, guildId, { voiceDebugTail }),
          },
          '[vc-memo/voice] connection state changed'
        );
      });

    } catch (err) {
      _cleanUpGatewayListeners();
      reject(err);
    }
  });
}

function leaveVoiceChannel() {
  unsubscribeAll();
  _cleanUpReceiverSpeakingListeners();
  _cleanUpGatewayListeners();
  clearSpeakingBuffers();
  speakStartCallback = null;
  speakEndCallback = null;
  subscriber = null;
  _resolvedReceiver = null;
  activeGuildId = null;

  if (voiceConnection) {
    logger.info('[vc-memo/voice] leaving voice channel');
    try {
      voiceConnection.destroy();
    } catch (err) {
      logger.error({ err }, '[vc-memo/voice] error destroying voice connection');
    }
    voiceConnection = null;
  }
}

function onSpeakingStart(callback) {
  speakStartCallback = callback;
}

function onSpeakingEnd(callback) {
  speakEndCallback = callback;
}

function getSubscriber() {
  return subscriber;
}

function setSubscriber(sub) {
  subscriber = sub;
}

function getSpeakingBuffers() {
  return speakingBuffers;
}

function recordSpeakingBufferTimeline(userId, packetBuffer) {
  if (!userId || !packetBuffer) {
    return;
  }
  speakingBufferTimeline.push({
    userId,
    packetBuffers: [packetBuffer],
  });
}

function getSpeakingBufferTimeline() {
  return speakingBufferTimeline;
}

function clearSpeakingBuffers() {
  speakingBuffers.clear();
  speakingBufferTimeline.length = 0;
}

let _resolvedReceiver = null;

function onVoiceConnectionReady(connection, channelId, guildId) {
  if (
    !connection ||
    !connection.receiver ||
    typeof connection.receiver.subscribe !== 'function'
  ) {
    throw new Error('Voice connection receiver is not available');
  }

  voiceConnection = connection;
  activeGuildId = guildId;
  _cleanUpReceiverSpeakingListeners();

  const handleSpeakingStart = (userId) => {
    logger.info('[vc-memo/voice] speaking started');
    subscribeToUser(userId);
    if (speakStartCallback) {
      try {
        speakStartCallback(userId);
      } catch (err) {
        logger.error({ err }, '[vc-memo/voice] speakStartCallback error');
      }
    }
  };

  const handleSpeakingEnd = (userId) => {
    logger.info('[vc-memo/voice] speaking ended');
    if (speakEndCallback) {
      try {
        speakEndCallback(userId);
      } catch (err) {
        logger.error({ err }, '[vc-memo/voice] speakEndCallback error');
      }
    }
  };

  if (connection.receiver.speaking && typeof connection.receiver.speaking.on === 'function') {
    _addEmitterListener(connection.receiver.speaking, 'start', handleSpeakingStart);
    _addEmitterListener(connection.receiver.speaking, 'end', handleSpeakingEnd);
  } else {
    logger.warn(
      { channelId, guildId },
      '[vc-memo/voice] receiver speaking events unavailable; using SSRC map events only'
    );
  }

  _resolvedReceiver = connection.receiver;

  if (connection.receiver.ssrcMap && typeof connection.receiver.ssrcMap.on === 'function') {
    const handleSsrcCreate = (data) => {
      if (data && data.userId) subscribeToUser(data.userId);
    };
    const handleSsrcUpdate = (_oldData, data) => {
      if (data && data.userId) subscribeToUser(data.userId);
    };
    _addEmitterListener(connection.receiver.ssrcMap, 'create', handleSsrcCreate);
    _addEmitterListener(connection.receiver.ssrcMap, 'update', handleSsrcUpdate);
  }

  logger.info({ channelId, guildId }, '[vc-memo/voice] speaking listeners registered');
}

function subscribeToUser(userId) {
  if (!voiceConnection?.receiver || activeSubscriptions.has(userId)) {
    return activeSubscriptions.get(userId) || null;
  }

  let stream;
  try {
    stream = voiceConnection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 },
    });
  } catch (err) {
    logger.error({ err }, '[vc-memo/voice] failed to subscribe to receiver audio');
    return null;
  }

  if (!stream) {
    return null;
  }

  if (typeof stream.on !== 'function') {
    logger.warn({ userId }, '[vc-memo/voice] receiver audio stream is not an event emitter');
    return null;
  }

  stream.on('data', (opusData) => {
    logger.debug('[vc-memo/voice] received opus data');
    processOpusData(userId, opusData);
  });

  const cleanupSubscription = () => {
    activeSubscriptions.delete(userId);
  };

  stream.on('end', cleanupSubscription);
  stream.on('close', cleanupSubscription);
  stream.on('error', (err) => {
    logger.error({ err }, '[vc-memo/voice] receiver audio stream error');
    cleanupSubscription();
  });

  activeSubscriptions.set(userId, stream);
  return stream;
}

function processOpusData(userId, opusData) {
  const { processOpusPacket } = require('./audio-processor');
  try {
    if (opusData instanceof Float32Array || opusData instanceof Int16Array || Buffer.isBuffer(opusData)) {
      processOpusPacket(userId, opusData, { guildId: activeGuildId });
    } else if (Array.isArray(opusData)) {
      for (const frame of opusData) {
        if (frame) {
          processOpusPacket(userId, frame, { guildId: activeGuildId });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, '[vc-memo/voice] opus data processing error');
  }
}

function unsubscribeAll() {
  for (const stream of activeSubscriptions.values()) {
    try {
      if (typeof stream.destroy === 'function') {
        stream.destroy();
      }
    } catch (err) {
      logger.error({ err }, '[vc-memo/voice] error destroying stream');
    }
  }
  activeSubscriptions.clear();
}

function getResolvedReceiver() {
  return _resolvedReceiver;
}

module.exports = {
  voiceJoinChannel,
  leaveVoiceChannel,
  onSpeakingStart,
  onSpeakingEnd,
  getSubscriber,
  setSubscriber,
  getSpeakingBuffers,
  getSpeakingBufferTimeline,
  recordSpeakingBufferTimeline,
  clearSpeakingBuffers,
  onVoiceConnectionReady,
  unsubscribeAll,
  getResolvedReceiver,
};
