const {
  OpenAiImageIntentError,
  createOpenAiImageIntentDetector,
  parseIntentPayload,
} = require("../src/image-generation-openai-intent");

const createResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(payload),
});

describe("image-generation-openai-intent", () => {
  it("sends a Responses API structured output request and parses JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse(200, {
      output_text: JSON.stringify({
        is_image_request: true,
        confidence: 0.91,
        purpose: "thumbnail",
        summary: "創作コミュニティのサムネ",
        abstract_model: "standard",
        needs_confirmation: true,
      }),
    }));
    const detector = createOpenAiImageIntentDetector({
      apiKey: "sk-test-secret",
      model: "gpt-test",
      apiBase: "https://api.openai.test",
      fetchImpl,
      timeoutMs: 1234,
    });

    const result = await detector("この内容でサムネ画像を作って");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.test/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test-secret",
          "Content-Type": "application/json",
        },
        signal: expect.any(AbortSignal),
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "gpt-test",
      text: {
        format: {
          type: "json_schema",
          name: "dokobasho_image_intent",
          strict: true,
        },
      },
    });
    expect(body.text.format.schema.required).toEqual(expect.arrayContaining([
      "is_image_request",
      "confidence",
      "purpose",
      "summary",
      "abstract_model",
      "needs_confirmation",
    ]));
    expect(body.text.format.schema.required).not.toContain("prompt_seed");
    expect(body.text.format.schema.properties.prompt_seed).toEqual({ type: "string" });
    expect(result).toEqual({
      is_image_request: true,
      confidence: 0.91,
      purpose: "thumbnail",
      summary: "創作コミュニティのサムネ",
      abstract_model: "standard",
      needs_confirmation: true,
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("throws an explicit creation error when apiKey is missing", () => {
    expect(() => createOpenAiImageIntentDetector({ fetchImpl: jest.fn() })).toThrow(
      OpenAiImageIntentError
    );
  });

  it("keeps request failures sanitized", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse(500, {
      error: { message: "raw upstream message" },
    }));
    const detector = createOpenAiImageIntentDetector({
      apiKey: "sk-test-secret",
      fetchImpl,
    });

    await expect(detector("private prompt body")).rejects.toMatchObject({
      name: "OpenAiImageIntentError",
      code: "openai_request_failed",
      statusCode: 500,
      retryable: true,
    });
    await expect(detector("private prompt body")).rejects.not.toThrow("private prompt body");
    await expect(detector("private prompt body")).rejects.not.toThrow("sk-test-secret");
  });

  it("parses nested Responses output content", () => {
    expect(parseIntentPayload({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                is_image_request: false,
                confidence: 0.2,
                purpose: "other",
                summary: "",
                abstract_model: "standard",
                needs_confirmation: false,
              }),
            },
          ],
        },
      ],
    })).toMatchObject({
      is_image_request: false,
      confidence: 0.2,
      purpose: "other",
    });
  });

  it("parses optional prompt_seed when present", () => {
    expect(parseIntentPayload({
      output_text: JSON.stringify({
        is_image_request: true,
        confidence: 0.86,
        purpose: "announcement",
        summary: "告知画像",
        abstract_model: "standard",
        needs_confirmation: true,
        prompt_seed: "告知画像の短い種",
      }),
    })).toMatchObject({
      is_image_request: true,
      purpose: "announcement",
      prompt_seed: "告知画像の短い種",
    });
  });
});
