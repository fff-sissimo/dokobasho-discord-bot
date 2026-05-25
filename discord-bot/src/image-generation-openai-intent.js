"use strict";

const { PURPOSE_PRESETS } = require("./image-generation-config");

const DEFAULT_OPENAI_INTENT_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_API_BASE = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 30000;

class OpenAiImageIntentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OpenAiImageIntentError";
    this.code = details.code || "openai_intent_error";
    this.statusCode = Number.isInteger(details.statusCode) ? details.statusCode : null;
    this.retryable = Boolean(details.retryable);
  }
}

const INTENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "is_image_request",
    "confidence",
    "purpose",
    "summary",
    "abstract_model",
    "needs_confirmation",
  ],
  properties: {
    is_image_request: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    purpose: {
      type: "string",
      enum: Object.keys(PURPOSE_PRESETS),
    },
    summary: { type: "string" },
    abstract_model: {
      type: "string",
      enum: ["fast", "standard", "high_quality"],
    },
    needs_confirmation: { type: "boolean" },
    prompt_seed: { type: "string" },
  },
});

const createTimeoutSignal = ({ timeoutMs, externalSignal }) => {
  const controller = new AbortController();
  let timeoutId = null;

  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  timeoutId = setTimeout(() => {
    const error = new Error("OpenAI intent request timed out.");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  if (timeoutId && typeof timeoutId.unref === "function") timeoutId.unref();

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
    },
  };
};

const buildResponsesBody = ({ model, text }) => ({
  model,
  input: [
    {
      role: "system",
      content:
        "You classify whether a Discord message is a clear image generation request. Return JSON only.",
    },
    {
      role: "user",
      content: String(text || ""),
    },
  ],
  text: {
    format: {
      type: "json_schema",
      name: "dokobasho_image_intent",
      strict: true,
      schema: INTENT_SCHEMA,
    },
  },
});

const extractOutputText = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.output_text === "string") return payload.output_text;

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") return content.text;
      if (typeof content.output_text === "string") return content.output_text;
    }
  }
  return null;
};

const parseIntentPayload = (payload) => {
  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new OpenAiImageIntentError("OpenAI intent response did not include structured output.", {
      code: "missing_structured_output",
      retryable: false,
    });
  }

  try {
    const parsed = JSON.parse(outputText);
    return {
      is_image_request: Boolean(parsed.is_image_request),
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
      purpose: PURPOSE_PRESETS[parsed.purpose] ? parsed.purpose : "other",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      abstract_model: ["fast", "standard", "high_quality"].includes(parsed.abstract_model)
        ? parsed.abstract_model
        : "standard",
      needs_confirmation: Boolean(parsed.needs_confirmation),
      ...(typeof parsed.prompt_seed === "string" ? { prompt_seed: parsed.prompt_seed } : {}),
    };
  } catch (error) {
    throw new OpenAiImageIntentError("OpenAI intent response was not valid JSON.", {
      code: "invalid_structured_output",
      retryable: false,
    });
  }
};

const createOpenAiImageIntentDetector = ({
  apiKey,
  model = DEFAULT_OPENAI_INTENT_MODEL,
  apiBase = DEFAULT_OPENAI_API_BASE,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  if (!apiKey) {
    throw new OpenAiImageIntentError("OpenAI API key is required for image intent detection.", {
      code: "missing_api_key",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new OpenAiImageIntentError("fetch implementation is required for image intent detection.", {
      code: "missing_fetch",
    });
  }

  const endpoint = `${String(apiBase).replace(/\/$/, "")}/v1/responses`;

  return async (text, options = {}) => {
    const { signal, cleanup } = createTimeoutSignal({
      timeoutMs,
      externalSignal: options.signal,
    });

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildResponsesBody({ model, text })),
        signal,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new OpenAiImageIntentError("OpenAI intent request failed.", {
          code: "openai_request_failed",
          statusCode: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return parseIntentPayload(payload);
    } catch (error) {
      if (error instanceof OpenAiImageIntentError) throw error;
      const isAbort = error && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new OpenAiImageIntentError("OpenAI intent request failed.", {
        code: isAbort ? "timeout" : "network_error",
        retryable: !isAbort,
      });
    } finally {
      cleanup();
    }
  };
};

module.exports = {
  DEFAULT_OPENAI_API_BASE,
  DEFAULT_OPENAI_INTENT_MODEL,
  INTENT_SCHEMA,
  OpenAiImageIntentError,
  createOpenAiImageIntentDetector,
  parseIntentPayload,
};
