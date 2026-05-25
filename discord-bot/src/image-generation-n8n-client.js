"use strict";

const DEFAULT_TIMEOUT_MS = 130000;

const SAFE_ERROR_CATEGORIES = new Set([
  "auth_failed",
  "credential_error",
  "rate_limited",
  "upstream_unavailable",
  "timeout",
  "invalid_request",
  "quota_exceeded",
  "model_unavailable",
  "unknown",
]);

class ImageGenerationN8nError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ImageGenerationN8nError";
    this.code = details.code || "image_generation_error";
    this.category = normalizeCategory(details.category);
    this.statusCode = Number.isInteger(details.statusCode) ? details.statusCode : null;
    this.requestId = details.requestId || null;
    this.retryable = Boolean(details.retryable);
    this.executionStatusUnknown = Boolean(details.executionStatusUnknown);
  }
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const normalizeCategory = (category) => {
  if (SAFE_ERROR_CATEGORIES.has(category)) return category;
  return "unknown";
};

const categoryFromStatus = (statusCode) => {
  if (statusCode === 401 || statusCode === 403) return "auth_failed";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 400) return "invalid_request";
  if (statusCode === 402) return "quota_exceeded";
  if (statusCode === 404) return "model_unavailable";
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return "upstream_unavailable";
  return "unknown";
};

const isRetryableHttpStatus = (statusCode) => (
  statusCode === 502 || statusCode === 503 || statusCode === 504
);

const isRetryableCategory = (category) => (
  category === "upstream_unavailable" || category === "timeout"
);

const isLocalDevelopmentHost = (hostname) => (
  hostname === "localhost"
  || hostname === "127.0.0.1"
  || hostname === "::1"
  || hostname === "[::1]"
);

const validateWebhookUrl = (webhookUrl) => {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (error) {
    return {
      valid: false,
      reason: "invalid_url",
    };
  }

  if (parsed.protocol === "https:") {
    return { valid: true };
  }

  if (parsed.protocol === "http:" && isLocalDevelopmentHost(parsed.hostname)) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: "insecure_url",
  };
};

const shouldRetryImageGenerationResult = (result) => {
  if (!result || result.success) return false;
  if (result.executionStatusUnknown) return false;
  return isRetryableHttpStatus(result.statusCode) || isRetryableCategory(result.error && result.error.category);
};

const parseJsonResponse = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      success: false,
      error: {
        code: "invalid_json_response",
        message: "Image generation returned an invalid JSON response.",
        category: "unknown",
      },
    };
  }
};

const normalizeErrorBody = ({ body, statusCode, requestId }) => {
  const sourceError = body && typeof body === "object" ? body.error : null;
  const category = normalizeCategory(
    sourceError && sourceError.category
      ? sourceError.category
      : categoryFromStatus(statusCode)
  );
  const code = sourceError && sourceError.code ? sourceError.code : "openai_error";

  return {
    code,
    message: "Image generation failed.",
    upstream_status: sourceError && Object.prototype.hasOwnProperty.call(sourceError, "upstream_status")
      ? sourceError.upstream_status
      : statusCode,
    category,
    provider_error_code: sourceError && sourceError.provider_error_code
      ? sourceError.provider_error_code
      : null,
    provider_error_type: sourceError && sourceError.provider_error_type
      ? sourceError.provider_error_type
      : null,
    request_id: requestId,
  };
};

const normalizeImageGenerationResponse = ({ payload, httpStatusCode, requestId }) => {
  const body = payload;
  const effectiveStatusCode = httpStatusCode;

  if (body && typeof body === "object" && !Object.prototype.hasOwnProperty.call(body, "success")) {
    const responseRequestId = body.request_id || requestId;
    return {
      success: false,
      statusCode: effectiveStatusCode,
      request_id: responseRequestId,
      error: {
        code: "invalid_response_shape",
        message: "Image generation response shape is invalid.",
        upstream_status: effectiveStatusCode,
        category: "invalid_request",
        provider_error_code: null,
        provider_error_type: null,
        request_id: responseRequestId,
      },
      retryable: false,
      executionStatusUnknown: false,
    };
  }

  if (!body || typeof body !== "object") {
    const error = normalizeErrorBody({ body: null, statusCode: effectiveStatusCode, requestId });
    return {
      success: false,
      statusCode: effectiveStatusCode,
      request_id: requestId,
      error,
      retryable: false,
      executionStatusUnknown: false,
    };
  }

  const responseRequestId = body.request_id || requestId;
  if (body.success === true && body.image_base64) {
    return {
      success: true,
      dry_run: Boolean(body.dry_run),
      request_id: responseRequestId,
      provider: body.provider || null,
      model: body.model || null,
      mode: body.mode || null,
      output_format: body.output_format || "base64",
      image_base64: body.image_base64,
      mime_type: body.mime_type || "image/png",
      statusCode: effectiveStatusCode,
      retryable: false,
      executionStatusUnknown: false,
    };
  }

  if (body.success === true && !body.image_base64) {
    const error = {
      code: "missing_image_base64",
      message: "Image generation response did not include image data.",
      upstream_status: effectiveStatusCode,
      category: "invalid_request",
      provider_error_code: null,
      provider_error_type: null,
      request_id: responseRequestId,
    };
    return {
      success: false,
      dry_run: Boolean(body.dry_run),
      request_id: responseRequestId,
      provider: body.provider || null,
      model: body.model || null,
      statusCode: effectiveStatusCode,
      error,
      retryable: false,
      executionStatusUnknown: false,
    };
  }

  const error = normalizeErrorBody({ body, statusCode: effectiveStatusCode, requestId: responseRequestId });
  const result = {
    success: false,
    dry_run: Boolean(body.dry_run),
    request_id: responseRequestId,
    provider: body.provider || null,
    model: body.model || null,
    statusCode: effectiveStatusCode,
    error,
    executionStatusUnknown: false,
  };
  result.retryable = shouldRetryImageGenerationResult(result);
  return result;
};

const createTimeoutSignal = ({ timeoutMs, externalSignal }) => {
  const controller = new AbortController();
  let timeoutId = null;

  const abortFromExternal = () => {
    controller.abort(externalSignal.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortFromExternal();
    } else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
  }

  timeoutId = setTimeout(() => {
    const error = new Error("Image generation request timed out.");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);

  if (timeoutId && typeof timeoutId.unref === "function") {
    timeoutId.unref();
  }

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortFromExternal);
    }
  };

  return { signal: controller.signal, cleanup };
};

const createImageGenerationN8nClient = ({
  webhookUrl,
  token,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = noopLogger,
} = {}) => {
  const generateImage = async (requestBody, options = {}) => {
    if (!webhookUrl) {
      throw new ImageGenerationN8nError("Image generation webhook URL is not configured.", {
        category: "credential_error",
        requestId: requestBody && requestBody.request_id,
      });
    }
    const urlValidation = validateWebhookUrl(webhookUrl);
    if (!urlValidation.valid) {
      throw new ImageGenerationN8nError("Image generation webhook URL must use https except for localhost development.", {
        code: urlValidation.reason,
        category: "credential_error",
        requestId: requestBody && requestBody.request_id,
      });
    }
    if (!token) {
      throw new ImageGenerationN8nError("Image generation webhook token is not configured.", {
        category: "credential_error",
        requestId: requestBody && requestBody.request_id,
      });
    }
    if (typeof fetchImpl !== "function") {
      throw new ImageGenerationN8nError("fetch implementation is not available.", {
        category: "credential_error",
        requestId: requestBody && requestBody.request_id,
      });
    }

    const requestId = requestBody && requestBody.request_id ? requestBody.request_id : null;
    const { signal, cleanup } = createTimeoutSignal({
      timeoutMs,
      externalSignal: options.signal,
    });

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal,
      });
      const payload = await parseJsonResponse(response);
      const result = normalizeImageGenerationResponse({
        payload,
        httpStatusCode: response.status,
        requestId,
      });
      result.retryable = shouldRetryImageGenerationResult(result);
      return result;
    } catch (error) {
      const isAbort = error && (error.name === "AbortError" || error.name === "TimeoutError");
      if (isAbort) {
        logger.warn("[image-generation] n8n request timed out or was aborted; not retrying because execution status is unknown.");
        return {
          success: false,
          request_id: requestId,
          statusCode: null,
          retryable: false,
          executionStatusUnknown: true,
          error: {
            code: "request_timeout",
            message: "Image generation request timed out.",
            upstream_status: null,
            category: "timeout",
            provider_error_code: null,
            provider_error_type: null,
            request_id: requestId,
          },
        };
      }

      logger.warn("[image-generation] n8n request failed before a response was received.");
      return {
        success: false,
        request_id: requestId,
        statusCode: null,
        retryable: true,
        executionStatusUnknown: false,
        error: {
          code: "network_error",
          message: "Image generation request failed.",
          upstream_status: null,
          category: "upstream_unavailable",
          provider_error_code: null,
          provider_error_type: null,
          request_id: requestId,
        },
      };
    } finally {
      cleanup();
    }
  };

  return {
    generateImage,
  };
};

const createImageGenerationClient = createImageGenerationN8nClient;

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SAFE_ERROR_CATEGORIES,
  ImageGenerationN8nError,
  createImageGenerationClient,
  createImageGenerationN8nClient,
  normalizeImageGenerationResponse,
  shouldRetryImageGenerationResult,
  validateWebhookUrl,
};
