"use strict";

const sanitizeSummaryText = (value) =>
  String(value).replace(/[?？]/g, "").replace(/\s+/g, " ").trim();

const stripReplyMetadata = (value) =>
  String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("Request:") && !line.includes("進捗:"))
    .join(" ");

const DEFAULT_PLAN_SENTENCE = "まず文脈と関連情報を整理して、要点からわかりやすく返すね。";

const buildFallbackFirstReplyMessage = (invocationMessage) => {
  const summary = sanitizeSummaryText(invocationMessage).slice(0, 90);
  if (summary) return `${summary}のこと、すぐ確認するね。${DEFAULT_PLAN_SENTENCE} ちょっと待っててね。`;
  return `内容をすぐ確認するね。${DEFAULT_PLAN_SENTENCE} ちょっと待っててね。`;
};

const normalizeFirstReplyForDiscord = (raw, fallbackMessage) => {
  const withoutMeta = stripReplyMetadata(raw);
  const compact = sanitizeSummaryText(withoutMeta);
  if (!compact) return fallbackMessage;
  const hasNaturalPlan =
    compact.includes("まず") ||
    compact.includes("先に") ||
    compact.includes("これから") ||
    compact.includes("整理して") ||
    compact.includes("結論から");
  const withPolicy = hasNaturalPlan ? compact : `${compact} ${DEFAULT_PLAN_SENTENCE}`;
  return withPolicy.slice(0, 180);
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
    "日本語で、妖精のように親しみやすく、簡潔に1文または2文で返してください。",
    "制約:",
    "- 進捗ステータスやRequest IDは書かない",
    "- これからの進め方を口語で自然に伝える（例: まず〜してから〜するね）",
    "- 口調はやわらかく、親しみやすい語尾（〜するね、〜だよ）を使う",
    "- 「方針:」のようなラベルは使わない",
    "- 箇条書き・見出しは使わない",
    "- 疑問形にしない",
    "- 受付済みであることと、少し待つ案内を含める（例: ちょっと待っててね）",
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

const extractChatCompletionText = (body) => {
  if (!body || typeof body !== "object" || !Array.isArray(body.choices)) return "";
  const firstChoice = body.choices[0];
  const content = firstChoice && firstChoice.message && firstChoice.message.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join(" ")
    .trim();
};

const trimBaseUrl = (value) => String(value).replace(/\/+$/, "");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createOpenAiFirstReplyComposer = ({
  apiKey,
  model = "o4-mini",
  timeoutMs = 5000,
  apiBase = "https://api.openai.com",
  modelFallbacks = ["gpt-4.1-mini", "gpt-4o-mini"],
  retryDelayMs = 200,
  maxAttemptsPerModel = 1,
  fetchImpl = fetch,
}) => {
  const normalizedApiKey = String(apiKey || "").trim();
  if (!normalizedApiKey) throw new Error("OPENAI_API_KEY is empty");
  const base = trimBaseUrl(apiBase);
  const responsesEndpoint = `${base}/v1/responses`;
  const chatCompletionsEndpoint = `${base}/v1/chat/completions`;
  const safeTimeoutMs = Math.max(100, Number(timeoutMs) || 2500);
  const safeRetryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
  const safeMaxAttemptsPerModel = Math.max(1, Number(maxAttemptsPerModel) || 1);
  const modelCandidates = Array.from(
    new Set([model, ...(Array.isArray(modelFallbacks) ? modelFallbacks : [])].filter(Boolean))
  );

  return async ({ invocationMessage, contextExcerpt }) => {
    const prompt = buildPrompt({ invocationMessage, contextExcerpt });
    const errors = [];

    for (const candidateModel of modelCandidates) {
      for (let attempt = 1; attempt <= safeMaxAttemptsPerModel; attempt += 1) {
        const attemptWithEndpoint = async (endpoint, requestBody, extractor, apiLabel) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), safeTimeoutMs);
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
              throw new Error(`status=${response.status} body=${errorBody.slice(0, 200)}`);
            }

            const body = await response.json();
            const text = extractor(body);
            if (!text) throw new Error("empty output_text");
            return text;
          } catch (error) {
            const message =
              error instanceof Error && error.name === "AbortError"
                ? `timeoutMs=${safeTimeoutMs}`
                : String(error);
            errors.push(
              `api=${apiLabel} model=${candidateModel} attempt=${attempt} error=${sanitizeSummaryText(message).slice(0, 200)}`
            );
            return "";
          } finally {
            clearTimeout(timer);
          }
        };

        const responsesRequestBody = {
          model: candidateModel,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: "簡潔な一次受付メッセージを作成してください。" }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          ],
          max_output_tokens: 120,
        };

        const responsesText = await attemptWithEndpoint(
          responsesEndpoint,
          responsesRequestBody,
          extractOutputText,
          "responses"
        );
        if (responsesText) return responsesText;

        const chatCompletionsRequestBody = {
          model: candidateModel,
          messages: [
            {
              role: "developer",
              content: "簡潔な一次受付メッセージを作成してください。",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_completion_tokens: 120,
        };
        const chatCompletionsText = await attemptWithEndpoint(
          chatCompletionsEndpoint,
          chatCompletionsRequestBody,
          extractChatCompletionText,
          "chat.completions"
        );
        if (chatCompletionsText) return chatCompletionsText;

        if (attempt < safeMaxAttemptsPerModel && safeRetryDelayMs > 0) {
          await delay(safeRetryDelayMs);
        }
      }
    }

    throw new Error(`openai first reply failed: ${errors.join(" | ").slice(0, 1000)}`);
  };
};

module.exports = {
  buildFallbackFirstReplyMessage,
  normalizeFirstReplyForDiscord,
  createOpenAiFirstReplyComposer,
};
