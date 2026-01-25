const { createWebhookRequestBuilder } = require("../src/n8n-webhook");

const createLogger = () => ({
  warn: jest.fn(),
});

test("adds x-webhook-secret header when secret is set", () => {
  const logger = createLogger();
  const builder = createWebhookRequestBuilder({
    webhookUrl: "https://example.com/webhook",
    webhookSecret: "secret",
    logger,
  });

  expect(builder.shouldSend()).toBe(true);
  const headers = builder.buildHeaders();
  expect(headers["content-type"]).toBe("application/json");
  expect(headers["x-webhook-secret"]).toBe("secret");
  expect(logger.warn).not.toHaveBeenCalled();
});

test("warns once when secret is missing", () => {
  const logger = createLogger();
  const builder = createWebhookRequestBuilder({
    webhookUrl: "https://example.com/webhook",
    webhookSecret: "",
    logger,
  });

  expect(builder.shouldSend()).toBe(true);
  const headers1 = builder.buildHeaders();
  const headers2 = builder.buildHeaders();
  expect(headers1["x-webhook-secret"]).toBeUndefined();
  expect(headers2["x-webhook-secret"]).toBeUndefined();
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

test("blocks sending when secret is set but url is http", () => {
  const logger = createLogger();
  const builder = createWebhookRequestBuilder({
    webhookUrl: "http://example.com/webhook",
    webhookSecret: "secret",
    logger,
  });

  expect(builder.shouldSend()).toBe(false);
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

test("shouldSend returns false when webhookUrl is empty", () => {
  const logger = createLogger();
  const builder = createWebhookRequestBuilder({
    webhookUrl: "",
    webhookSecret: "secret",
    logger,
  });

  expect(builder.shouldSend()).toBe(false);
  expect(logger.warn).not.toHaveBeenCalled();
});
