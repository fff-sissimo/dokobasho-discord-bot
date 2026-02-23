"use strict";

const sanitizeSummaryText = (value) =>
  String(value).replace(/[?？]/g, "").replace(/\s+/g, " ").trim();

const stripReplyMetadata = (value) =>
  String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("Request:") && !line.includes("進捗:"))
    .join(" ");

const buildFallbackFirstReplyMessage = (invocationMessage) => {
  const summary = sanitizeSummaryText(invocationMessage).slice(0, 90);
  if (summary) return `${summary}を確認して進めます。少し待ってください。`;
  return "内容を確認して進めます。少し待ってください。";
};

const normalizeFirstReplyForDiscord = (raw, fallbackMessage) => {
  const withoutMeta = stripReplyMetadata(raw);
  const compact = sanitizeSummaryText(withoutMeta);
  if (!compact) return fallbackMessage;
  return compact.slice(0, 180);
};

const buildPrompt = ({ invocationMessage, contextExcerpt }) => {
  const normalizedInvocation = sanitizeSummaryText(invocationMessage) || "依頼内容を確認";
  const contextPreview = (Array.isArray(contextExcerpt) ? contextExcerpt : [])
    .map((line) => sanitizeSummaryText(line))
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");

  return [
    "あなたはDiscordで一次受付メッセージだけを返すアシスタントです。",
    "日本語で、簡潔に1文または2文で返してください。",
    "制約:",
    "- 進捗ステータスやRequest IDは書かない",
    "- 箇条書き・見出しは使わない",
    "- 疑問形にしない",
    "- 受付済みであることと、少し待つ案内を含める",
    "",
    `依頼: ${normalizedInvocation}`,
    contextPreview ? `参考文脈: ${contextPreview}` : "参考文脈: なし",
  ].join("\n");
};

const extractOutputText = (body) => {
  if (!body || typeof body !== "object") return "";

  if (typeof body.output_text === "string" && body.output_text.trim().length > 0) {
    return body.output_text;
  }

  if (!Array.isArray(body.output)) return "";
  for (const item of body.output) {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "output_text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0
      ) {
        return block.text;
      }
    }
  }
  return "";
};

const trimBaseUrl = (value) => String(value).replace(/\/+$/, "");

const createOpenAiFirstReplyComposer = ({
  apiKey,
  model = "o4-mini",
  timeoutMs = 2500,
  apiBase = "https://api.openai.com",
  fetchImpl = fetch,
}) => {
  const normalizedApiKey = String(apiKey || "").trim();
  if (!normalizedApiKey) throw new Error("OPENAI_API_KEY is empty");
  const endpoint = `${trimBaseUrl(apiBase)}/v1/responses`;
  const safeTimeoutMs = Math.max(100, Number(timeoutMs) || 2500);

  return async ({ invocationMessage, contextExcerpt }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), safeTimeoutMs);
    const requestBody = {
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: "簡潔な一次受付メッセージを作成してください。" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildPrompt({ invocationMessage, contextExcerpt }) }],
        },
      ],
      max_output_tokens: 120,
    };

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${normalizedApiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`openai first reply failed: status=${response.status} body=${errorBody.slice(0, 240)}`);
      }

      const body = await response.json();
      const text = extractOutputText(body);
      if (!text) throw new Error("openai first reply failed: empty output_text");
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`openai first reply timed out: timeoutMs=${safeTimeoutMs}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
};

module.exports = {
  buildFallbackFirstReplyMessage,
  normalizeFirstReplyForDiscord,
  createOpenAiFirstReplyComposer,
};
