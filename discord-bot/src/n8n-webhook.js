"use strict";

const createWebhookRequestBuilder = ({ webhookUrl, webhookSecret, logger }) => {
  let warnedMissingSecret = false;
  let warnedInsecureWebhook = false;

  const shouldSend = () => {
    if (!webhookUrl) return false;
    if (webhookSecret && !webhookUrl.toLowerCase().startsWith("https://")) {
      if (!warnedInsecureWebhook) {
        logger.warn("[webhook] N8N_WEBHOOK_URL is not https. The webhook secret may be exposed.");
        warnedInsecureWebhook = true;
      }
      return false;
    }
    return true;
  };

  const buildHeaders = () => {
    const headers = { "content-type": "application/json" };
    if (!webhookSecret) {
      if (!warnedMissingSecret) {
        logger.warn("[webhook] N8N_WEBHOOK_SECRET is not set. Requests may be rejected by n8n.");
        warnedMissingSecret = true;
      }
      return headers;
    }
    headers["x-webhook-secret"] = webhookSecret;
    return headers;
  };

  return {
    shouldSend,
    buildHeaders,
  };
};

module.exports = {
  createWebhookRequestBuilder,
};
