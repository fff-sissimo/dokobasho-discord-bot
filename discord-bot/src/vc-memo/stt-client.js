const logger = require('../logger');

const apiBase = process.env.VC_MEMO_OPENAI_BASE_URL || 'https://api.openai.com/v1';
const apiKey = process.env.VC_MEMO_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const language = process.env.VC_MEMO_STT_LANGUAGE || 'ja';

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function transcribe(wavBuffer, options = {}) {
  const normalized = typeof options === 'number' ? { retries: options } : options;
  const retries = Number(normalized.retries ?? process.env.VC_MEMO_STT_RETRIES ?? 3);
  const timeoutMs = Number(normalized.timeoutMs ?? process.env.VC_MEMO_STT_TIMEOUT_MS ?? 60_000);
  const retryDelayMs = Number(normalized.retryDelayMs ?? 1_000);
  const fetchImpl = normalized.fetchImpl || global.fetch;
  const url = `${apiBase}/audio/transcriptions`;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const formData = new FormData();
      formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'recording.wav');
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`Transcription request failed (status ${response.status})`);
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }
      const data = await response.json();
      return data.text || '';
    } catch (err) {
      const retryable = err.retryable !== false && (err.name === 'AbortError' || err.retryable === true || !('retryable' in err));
      logger.warn({ status: err.status, attempt, retries, retryable }, '[vc-memo/stt] transcription request failed');
      if (!retryable || attempt === retries) {
        logger.error({ err: err.message, attempt, retries }, '[vc-memo/stt] transcription failed permanently');
        throw err;
      }
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (2 ** (attempt - 1))));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return '';
}

module.exports = { isRetryableStatus, transcribe };
