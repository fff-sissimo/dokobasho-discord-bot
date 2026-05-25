const {
  createImageGenerationClient,
  ImageGenerationN8nError,
  normalizeImageGenerationResponse,
  shouldRetryImageGenerationResult,
  validateWebhookUrl,
} = require("../src/image-generation-n8n-client");

const createResponse = (status, payload) => ({
  status,
  text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
});

const requestBody = {
  request_id: "req-1",
  provider: "openai",
  model: "gpt-image-1.5",
  prompt: "private prompt",
  purpose: "thumbnail",
  aspect_ratio: "landscape",
  size: "1536x1024",
  quality: "auto",
  return_format: "base64",
  metadata: {
    source: "hermes-discord",
    guild_id: "guild-1",
    channel_id: "channel-1",
    user_id: "user-1",
    trigger_type: "natural_language",
    purpose: "thumbnail",
  },
};

test("sends bearer JSON request and returns successful flat response", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(createResponse(200, {
    success: true,
    request_id: "req-1",
    provider: "openai",
    model: "gpt-image-1.5",
    image_base64: "base64-data",
    mime_type: "image/png",
    prompt_used: "private prompt",
    provider_request_preview: { prompt: "private prompt" },
  }));
  const client = createImageGenerationClient({
    webhookUrl: "https://example.com/webhook",
    token: "secret-token",
    fetchImpl,
  });

  const result = await client.generateImage(requestBody);

  expect(fetchImpl).toHaveBeenCalledWith("https://example.com/webhook", expect.objectContaining({
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: expect.any(AbortSignal),
  }));
  expect(result.success).toBe(true);
  expect(result.image_base64).toBe("base64-data");
  expect(result.prompt_used).toBeUndefined();
  expect(result.provider_request_preview).toBeUndefined();
});

test("requires https webhook URL except localhost development endpoints", async () => {
  expect(validateWebhookUrl("https://example.com/webhook").valid).toBe(true);
  expect(validateWebhookUrl("http://localhost:5678/webhook").valid).toBe(true);
  expect(validateWebhookUrl("http://127.0.0.1:5678/webhook").valid).toBe(true);
  expect(validateWebhookUrl("http://[::1]:5678/webhook").valid).toBe(true);
  expect(validateWebhookUrl("http://example.com/webhook")).toEqual({
    valid: false,
    reason: "insecure_url",
  });

  const fetchImpl = jest.fn();
  const client = createImageGenerationClient({
    webhookUrl: "http://example.com/webhook",
    token: "secret-token",
    fetchImpl,
  });

  await expect(client.generateImage(requestBody)).rejects.toMatchObject({
    name: "ImageGenerationN8nError",
    category: "credential_error",
    code: "insecure_url",
  });
  await expect(client.generateImage(requestBody)).rejects.toBeInstanceOf(ImageGenerationN8nError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("rejects statusCode/body wrapper as invalid response shape", () => {
  const result = normalizeImageGenerationResponse({
    httpStatusCode: 200,
    requestId: "req-1",
    payload: {
      statusCode: 200,
      body: {
        success: true,
        request_id: "req-1",
      },
    },
  });

  expect(result.success).toBe(false);
  expect(result.error.category).toBe("invalid_request");
  expect(result.error.code).toBe("invalid_response_shape");
});

test("treats flat success without image_base64 as failure", () => {
  const result = normalizeImageGenerationResponse({
    httpStatusCode: 200,
    requestId: "req-1",
    payload: {
      success: true,
      request_id: "req-1",
    },
  });

  expect(result.success).toBe(false);
  expect(result.error.category).toBe("invalid_request");
  expect(result.error.code).toBe("missing_image_base64");
});

test("keeps error response sanitized and retryable only for safe upstream categories", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(createResponse(502, {
    success: false,
    request_id: "req-1",
    error: {
      code: "openai_error",
      message: "raw provider details should not be forwarded",
      upstream_status: 502,
      category: "upstream_unavailable",
    },
  }));
  const client = createImageGenerationClient({
    webhookUrl: "https://example.com/webhook",
    token: "secret-token",
    fetchImpl,
  });

  const result = await client.generateImage(requestBody);

  expect(result.success).toBe(false);
  expect(result.retryable).toBe(true);
  expect(result.error).toEqual(expect.objectContaining({
    code: "openai_error",
    message: "Image generation failed.",
    upstream_status: 502,
    category: "upstream_unavailable",
  }));
  expect(JSON.stringify(result)).not.toContain("private prompt");
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

test("does not retry AbortError because execution status is unknown", async () => {
  const logger = { warn: jest.fn() };
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const fetchImpl = jest.fn().mockRejectedValue(abortError);
  const client = createImageGenerationClient({
    webhookUrl: "https://example.com/webhook",
    token: "secret-token",
    fetchImpl,
    logger,
  });

  const result = await client.generateImage(requestBody);

  expect(result.success).toBe(false);
  expect(result.error.category).toBe("timeout");
  expect(result.retryable).toBe(false);
  expect(result.executionStatusUnknown).toBe(true);
});

test("does not retry TimeoutError because execution status is unknown", async () => {
  const timeoutError = new Error("timed out");
  timeoutError.name = "TimeoutError";
  const fetchImpl = jest.fn().mockRejectedValue(timeoutError);
  const client = createImageGenerationClient({
    webhookUrl: "https://example.com/webhook",
    token: "secret-token",
    fetchImpl,
  });

  const result = await client.generateImage(requestBody);

  expect(result.success).toBe(false);
  expect(result.error.category).toBe("timeout");
  expect(result.retryable).toBe(false);
  expect(result.executionStatusUnknown).toBe(true);
});

test("retries when n8n returns safe JSON timeout or upstream unavailable response", async () => {
  const timeoutResult = normalizeImageGenerationResponse({
    httpStatusCode: 200,
    requestId: "req-1",
    payload: {
      success: false,
      request_id: "req-1",
      error: {
        code: "openai_error",
        upstream_status: null,
        category: "timeout",
      },
    },
  });
  timeoutResult.retryable = shouldRetryImageGenerationResult(timeoutResult);

  const unavailableResult = normalizeImageGenerationResponse({
    httpStatusCode: 503,
    requestId: "req-1",
    payload: {
      success: false,
      request_id: "req-1",
      error: {
        code: "openai_error",
        upstream_status: 503,
        category: "upstream_unavailable",
      },
    },
  });
  unavailableResult.retryable = shouldRetryImageGenerationResult(unavailableResult);

  expect(timeoutResult.retryable).toBe(true);
  expect(unavailableResult.retryable).toBe(true);
});

test("retries HTTP 502/503/504 failure responses even when category is absent", () => {
  for (const statusCode of [502, 503, 504]) {
    const result = normalizeImageGenerationResponse({
      httpStatusCode: statusCode,
      requestId: "req-1",
      payload: {
        success: false,
        request_id: "req-1",
        error: {
          code: "openai_error",
        },
      },
    });
    result.retryable = shouldRetryImageGenerationResult(result);
    expect(result.error.category).toBe("upstream_unavailable");
    expect(result.retryable).toBe(true);
  }
});

test("retry helper rejects unknown execution status even for timeout category", () => {
  expect(shouldRetryImageGenerationResult({
    success: false,
    statusCode: null,
    executionStatusUnknown: true,
    error: { category: "timeout" },
  })).toBe(false);
});
