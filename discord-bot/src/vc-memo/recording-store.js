const fs = require('fs');
const path = require('path');

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = CHANNELS * (BITS_PER_SAMPLE / 8);
const DEFAULT_MAX_SESSION_BYTES = 100 * 1024 * 1024;

function safeFileId(userId) {
  return Buffer.from(String(userId), 'utf8').toString('base64url');
}

function buildWavHeader(dataSize) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = SAMPLE_RATE * BLOCK_ALIGN;
  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

function createRecordingStore({ rootDir, sessionId, maxSessionBytes } = {}) {
  if (!rootDir || !sessionId) {
    throw new Error('rootDir and sessionId are required');
  }

  const sessionDir = path.join(rootDir, String(sessionId));
  const manifestPath = path.join(sessionDir, 'manifest.jsonl');
  const transcriptPath = path.join(sessionDir, 'transcript.txt');
  const users = new Set();
  const configuredMaxSessionBytes = Number(maxSessionBytes ?? process.env.VC_MEMO_MAX_SESSION_BYTES ?? DEFAULT_MAX_SESSION_BYTES);
  const sessionByteLimit = Number.isFinite(configuredMaxSessionBytes) && configuredMaxSessionBytes > 0
    ? configuredMaxSessionBytes
    : null;
  let writtenPcmBytes = 0;
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const getPcmPath = (userId) => path.join(sessionDir, `speaker-${safeFileId(userId)}.pcm`);

  function appendPcm(userId, pcmBuffer) {
    const buffer = Buffer.from(pcmBuffer || []);
    if (!userId || buffer.length === 0) return;
    if (sessionByteLimit !== null && writtenPcmBytes + buffer.length > sessionByteLimit) {
      throw new Error('VC Memo session byte limit exceeded');
    }
    const pcmPath = getPcmPath(userId);
    const offset = fs.existsSync(pcmPath) ? fs.statSync(pcmPath).size : 0;
    fs.appendFileSync(pcmPath, buffer, { mode: 0o600 });
    fs.appendFileSync(
      manifestPath,
      `${JSON.stringify({ userId: String(userId), offset, bytes: buffer.length })}\n`,
      { mode: 0o600 }
    );
    users.add(String(userId));
    writtenPcmBytes += buffer.length;
  }

  function listUsers() {
    if (users.size === 0 && fs.existsSync(manifestPath)) {
      for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.userId) users.add(String(event.userId));
        } catch (_) {
          // A truncated final manifest line does not make already-written PCM unusable.
        }
      }
    }
    return [...users];
  }

  function* readWavChunks(userId, maxWavBytes) {
    const pcmPath = getPcmPath(userId);
    if (!fs.existsSync(pcmPath)) return;
    const configuredMax = Number(maxWavBytes);
    const maxBytes = Number.isFinite(configuredMax) && configuredMax > WAV_HEADER_BYTES
      ? configuredMax
      : 20 * 1024 * 1024;
    const maxPcmBytes = Math.max(
      BLOCK_ALIGN,
      Math.floor((maxBytes - WAV_HEADER_BYTES) / BLOCK_ALIGN) * BLOCK_ALIGN
    );
    const fileSize = fs.statSync(pcmPath).size;
    const descriptor = fs.openSync(pcmPath, 'r');
    try {
      let position = 0;
      while (position < fileSize) {
        const requestedBytes = Math.min(maxPcmBytes, fileSize - position);
        const alignedBytes = requestedBytes === fileSize - position
          ? requestedBytes
          : Math.floor(requestedBytes / BLOCK_ALIGN) * BLOCK_ALIGN;
        const pcm = Buffer.alloc(alignedBytes);
        const bytesRead = fs.readSync(descriptor, pcm, 0, alignedBytes, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        yield Buffer.concat([buildWavHeader(bytesRead), pcm.subarray(0, bytesRead)]);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function writeTranscript(text) {
    const temporaryPath = `${transcriptPath}.tmp`;
    fs.writeFileSync(temporaryPath, String(text || ''), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, transcriptPath);
    return transcriptPath;
  }

  function readTranscript() {
    return fs.readFileSync(transcriptPath, 'utf8');
  }

  return {
    sessionDir,
    appendPcm,
    getPcmPath,
    listUsers,
    readTranscript,
    readWavChunks,
    writeTranscript,
  };
}

module.exports = { createRecordingStore };
