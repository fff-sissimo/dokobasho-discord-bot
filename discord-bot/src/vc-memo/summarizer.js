const logger = require('../logger');

const apiBase = process.env.VC_MEMO_OPENAI_BASE_URL || 'https://api.openai.com/v1';
const apiKey = process.env.VC_MEMO_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const model = process.env.VC_MEMO_SUMMARY_MODEL || 'gpt-4o-mini';

const SUMMARY_KEYS = ['summary', 'conversationFlow', 'detailedNotes', 'decisions', 'todos', 'openQuestions'];
const SYSTEM_PROMPT = `あなたはDiscordボイスチャットの議事メモ作成アシスタントです。以下の文字起こしを分析し、構造化されたJSONだけを返してください。

次のキーを必ず含むJSONオブジェクトを返してください:
- "summary": 会話全体の要点をまとめた文字列配列
- "conversationFlow": 話題の移り変わりや発言の流れを時系列で追える文字列配列
- "detailedNotes": 背景、やりとり、結論/未決が追える詳細メモの文字列配列
- "decisions": 決定事項の文字列配列
- "todos": 対応事項やTODOの文字列配列
- "openQuestions": 未解決の確認事項の文字列配列

ルール:
- すべての出力文字列は日本語で書く
- "summary" は短くしすぎず、会話の主要論点を3から7項目程度で残す
- "conversationFlow" は時系列を優先し、話題ごとに何が話され、どう展開したかを追える粒度で書く
- "conversationFlow" では speaker-1 などの話者ラベルが有用なら含める
- "detailedNotes" は詳細メモとして、背景 → やりとり → 結論/未決 の流れを追える粒度で書く
- 長時間の会話でも "detailedNotes" を短く圧縮しすぎず、結論に必要な前提、反対意見、判断理由、未決事項を残す
- 雑談や相づちは省いてよいが、結論に至る前提・迷い・確認事項は残す
- 文字起こしにない内容は作らない`;

function emptySummary() {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, []]));
}

function normalizeSummaryData(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySummary();
  const result = emptySummary();
  for (const key of SUMMARY_KEYS) {
    result[key] = Array.isArray(parsed[key]) ? parsed[key].map(String) : [];
  }
  return result;
}

function splitTranscript(transcript, maxChunkChars) {
  const text = String(transcript || '');
  if (!text) return [''];
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxChunkChars) {
    chunks.push(text.slice(offset, offset + maxChunkChars));
  }
  return chunks;
}

async function summarizeChunk(chunk, speakerLabels, { timeoutMs, fetchImpl }) {
  const labels = speakerLabels?.length ? `${speakerLabels.join('\n')}\n\n` : '';
  const userContent = `${labels}--- TRANSCRIPT ---\n\n${chunk}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Summarization request failed (status ${response.status})`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    try {
      return normalizeSummaryData(JSON.parse(content));
    } catch (_) {
      logger.error('[vc-memo/summarizer] failed to parse response JSON');
      return emptySummary();
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function summarize(transcript, speakerLabels, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? process.env.VC_MEMO_SUMMARY_TIMEOUT_MS ?? 60_000);
  const maxChunkChars = Math.max(1, Number(options.maxChunkChars ?? process.env.VC_MEMO_SUMMARY_MAX_CHUNK_CHARS ?? 24_000));
  const fetchImpl = options.fetchImpl || global.fetch;
  const merged = emptySummary();
  try {
    for (const chunk of splitTranscript(transcript, maxChunkChars)) {
      const partial = await summarizeChunk(chunk, speakerLabels, { timeoutMs, fetchImpl });
      for (const key of SUMMARY_KEYS) merged[key].push(...partial[key]);
    }
    return merged;
  } catch (err) {
    logger.error({ err: err.message }, '[vc-memo/summarizer] summarization failed');
    throw err;
  }
}

module.exports = { normalizeSummaryData, splitTranscript, summarize };
