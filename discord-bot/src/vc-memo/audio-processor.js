const {
  getSpeakingBuffers,
  recordSpeakingBufferTimeline,
} = require('./voice-listener');
const OpusScript = require('opusscript');
const logger = require('../logger');

const userBuffers = new Map();
const decoders = new Map();
const recordingStoresByGuild = new Map();
const SAMPLE_RATE = 48000;
const NUM_CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const OPUS_FRAME_SIZE = 960;
const WAV_HEADER_BYTES = 44;
const DEFAULT_MAX_WAV_BYTES = 20 * 1024 * 1024;

function getMaxWavBytes() {
  const value = Number(process.env.VC_MEMO_STT_MAX_WAV_BYTES || DEFAULT_MAX_WAV_BYTES);
  if (!Number.isFinite(value) || value <= WAV_HEADER_BYTES) {
    return DEFAULT_MAX_WAV_BYTES;
  }
  return value;
}

function getPcmBlockAlign() {
  return NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
}

function getDecoder(userId) {
  if (!decoders.has(userId)) {
    decoders.set(
      userId,
      new OpusScript(SAMPLE_RATE, NUM_CHANNELS, OpusScript.Application.AUDIO)
    );
  }
  return decoders.get(userId);
}

function toBuffer(packet) {
  if (Buffer.isBuffer(packet)) {
    return packet;
  }
  if (packet instanceof Int16Array || packet instanceof Float32Array) {
    return Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  }
  return Buffer.from(packet);
}

function decodeOpusPacket(userId, opusPacket) {
  try {
    const packet = toBuffer(opusPacket);
    if (packet.length === 0) {
      return null;
    }
    return getDecoder(userId).decode(packet, OPUS_FRAME_SIZE);
  } catch (err) {
    logger.warn({ err }, '[vc-memo/audio] skipping undecodable opus packet');
    return null;
  }
}

function setRecordingStore(guildId, store) {
  if (!guildId || !store) throw new Error('guildId and recording store are required');
  recordingStoresByGuild.set(guildId, store);
}

function clearRecordingStore(guildId) {
  recordingStoresByGuild.delete(guildId);
}

function processOpusPacket(userId, opusPacket, { guildId } = {}) {
  const pcmBuffer = decodeOpusPacket(userId, opusPacket);
  if (!pcmBuffer || pcmBuffer.length === 0) {
    return;
  }

  const recordingStore = guildId ? recordingStoresByGuild.get(guildId) : null;
  if (recordingStore) {
    recordingStore.appendPcm(userId, pcmBuffer);
    return;
  }

  if (!userBuffers.has(userId)) {
    userBuffers.set(userId, []);
  }
  userBuffers.get(userId).push(pcmBuffer);
  const speakingBuffers = getSpeakingBuffers();
  if (!speakingBuffers.has(userId)) {
    speakingBuffers.set(userId, []);
  }
  speakingBuffers.get(userId).push(pcmBuffer);
  if (typeof recordSpeakingBufferTimeline === 'function') {
    recordSpeakingBufferTimeline(userId, pcmBuffer);
  }
}

function buildWavHeader(dataSize, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(dataSize + 36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function pcmBuffersToWav(pcmBuffers) {
  let totalLength = 0;
  for (const buf of pcmBuffers) {
    totalLength += buf.byteLength || buf.length;
  }

  const pcmBuffer = Buffer.alloc(totalLength);
  let offset = 0;
  for (const buf of pcmBuffers) {
    if (buf instanceof Int16Array) {
      const srcBuffer = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
      srcBuffer.copy(pcmBuffer, offset);
      offset += srcBuffer.length;
    } else if (buf instanceof Float32Array) {
      const srcBuffer = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
      srcBuffer.copy(pcmBuffer, offset);
      offset += srcBuffer.length;
    } else {
      const srcBuffer = Buffer.from(buf);
      srcBuffer.copy(pcmBuffer, offset);
      offset += srcBuffer.length;
    }
  }

  const header = buildWavHeader(totalLength, SAMPLE_RATE, NUM_CHANNELS, BITS_PER_SAMPLE);
  return Buffer.concat([header, pcmBuffer]);
}

function splitPcmBuffersToWavChunks(pcmBuffers, maxWavBytes = getMaxWavBytes()) {
  const maxDataBytes = Math.max(
    getPcmBlockAlign(),
    Math.floor((maxWavBytes - WAV_HEADER_BYTES) / getPcmBlockAlign()) * getPcmBlockAlign()
  );
  const chunks = [];
  let currentBuffers = [];
  let currentBytes = 0;

  const flush = () => {
    if (currentBuffers.length === 0) return;
    chunks.push(pcmBuffersToWav(currentBuffers));
    currentBuffers = [];
    currentBytes = 0;
  };

  for (const pcm of pcmBuffers) {
    const source = toBuffer(pcm);
    let offset = 0;

    while (offset < source.length) {
      const remainingCapacity = maxDataBytes - currentBytes;
      if (remainingCapacity <= 0) {
        flush();
        continue;
      }

      const remainingSource = source.length - offset;
      let takeBytes = Math.min(remainingCapacity, remainingSource);
      if (takeBytes < remainingSource) {
        takeBytes = Math.floor(takeBytes / getPcmBlockAlign()) * getPcmBlockAlign();
      }
      if (takeBytes <= 0) {
        flush();
        continue;
      }

      currentBuffers.push(source.subarray(offset, offset + takeBytes));
      currentBytes += takeBytes;
      offset += takeBytes;

      if (currentBytes >= maxDataBytes) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

function getDecodedWavBuffer() {
  const buffers = getSpeakingBuffers();
  let allPcm = [];

  for (const [userId, pcmBuffers] of buffers.entries()) {
    allPcm = allPcm.concat(pcmBuffers);
    buffers.set(userId, []);
  }

  if (allPcm.length === 0) {
    return null;
  }

  return pcmBuffersToWav(allPcm);
}

function getDecodedWavForUser(userId, pcmBuffersOverride) {
  const buffers = getSpeakingBuffers();
  const pcmBuffers = pcmBuffersOverride || buffers.get(userId) || [];
  if (!pcmBuffersOverride) {
    buffers.delete(userId);
  }

  if (pcmBuffers.length === 0) {
    return null;
  }

  return pcmBuffersToWav(pcmBuffers);
}

function getDecodedWavChunksForUser(userId, pcmBuffersOverride, maxWavBytes) {
  const buffers = getSpeakingBuffers();
  const pcmBuffers = pcmBuffersOverride || buffers.get(userId) || [];
  if (!pcmBuffersOverride) {
    buffers.delete(userId);
  }

  if (pcmBuffers.length === 0) {
    return [];
  }

  return splitPcmBuffersToWavChunks(pcmBuffers, maxWavBytes);
}

function reset() {
  userBuffers.clear();
  decoders.clear();
  recordingStoresByGuild.clear();
}

module.exports = {
  processOpusPacket,
  setRecordingStore,
  clearRecordingStore,
  getDecodedWavBuffer,
  getDecodedWavForUser,
  getDecodedWavChunksForUser,
  splitPcmBuffersToWavChunks,
  reset,
};
