const logger = require("./logger");
const { normalizeReplyAntecedentContent } = require("./fairy-fast-path");

// Discord.js v14 exposes replied-target metadata via message.reference.messageId and
// resolves the full message through message.fetchReference().
const resolveReplyAntecedentEntry = async (message) => {
  const referenceId = message.reference?.messageId;
  if (!referenceId) {
    return undefined;
  }
  if (typeof message.fetchReference !== "function") {
    logger.warn({ referenceId }, "[fairy] reply antecedent fetchReference unavailable");
    return undefined;
  }

  try {
    const referenced = await message.fetchReference();
    const messageId =
      typeof referenced?.id === "string" && referenced.id.trim()
        ? referenced.id.trim()
        : String(referenceId).trim();
    const authorUserId =
      typeof referenced?.author?.id === "string" ? referenced.author.id.trim() : "";
    const content =
      typeof referenced?.content === "string"
        ? normalizeReplyAntecedentContent(referenced.content)
        : "";

    // fairy-core v3 contract requires non-empty content for reply antecedents.
    if (!messageId || !authorUserId || !content) {
      return undefined;
    }

    const authorIsBot = Boolean(referenced.author?.bot);

    return {
      message_id: messageId,
      author_user_id: authorUserId,
      author_is_bot: authorIsBot,
      content,
    };
  } catch (error) {
    logger.warn({ referenceId, err: error }, "[fairy] reply antecedent resolution failed");
    return undefined;
  }
};

module.exports = {
  resolveReplyAntecedentEntry,
};
