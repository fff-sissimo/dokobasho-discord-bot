"use strict";

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MESSAGES } = require("./message-templates");

const IMAGE_BUTTON_PREFIX = "imagegen";
const CONFIRM_BUTTON_ACTION = "confirm";
const CANCEL_BUTTON_ACTION = "cancel";

const createButtonCustomId = (action, requestId) => `${IMAGE_BUTTON_PREFIX}:${action}:${requestId}`;

const parseImageButtonCustomId = (customId) => {
  const parts = String(customId || "").split(":");
  if (parts.length !== 3 || parts[0] !== IMAGE_BUTTON_PREFIX) return null;
  if (![CONFIRM_BUTTON_ACTION, CANCEL_BUTTON_ACTION].includes(parts[1])) return null;
  return {
    action: parts[1],
    requestId: parts[2],
  };
};

const createConfirmationComponents = (requestId, { disabled = false } = {}) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(createButtonCustomId(CONFIRM_BUTTON_ACTION, requestId))
      .setLabel(MESSAGES.imageGeneration.buttons.generate)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(createButtonCustomId(CANCEL_BUTTON_ACTION, requestId))
      .setLabel(MESSAGES.imageGeneration.buttons.cancel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  ),
];

const createQueueComponents = (requestId, { disabled = false } = {}) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(createButtonCustomId(CANCEL_BUTTON_ACTION, requestId))
      .setLabel(MESSAGES.imageGeneration.buttons.cancel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  ),
];

const mapErrorMessage = (category) => {
  const errors = MESSAGES.imageGeneration.errors;
  return errors[category] || errors.unknown;
};

const getUserLabel = (user) => String(
  (user && (user.globalName || user.username || user.tag || user.id)) || ""
);

const createImageAttachment = (image, requestId) => {
  const buffer = Buffer.from(String(image && image.base64 ? image.base64 : ""), "base64");
  return new AttachmentBuilder(buffer, {
    name: `${requestId || "image"}.png`,
  });
};

const safeEdit = async (message, payload) => {
  if (!message || typeof message.edit !== "function") return null;
  return message.edit(payload);
};

const replyEphemeral = async (interaction, content) => {
  if (!interaction || typeof interaction.reply !== "function") return null;
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp
      ? interaction.followUp({ content, ephemeral: true })
      : null;
  }
  return interaction.reply({ content, ephemeral: true });
};

const isConfirmRejectionReason = (reason) => (
  ["not_confirming", "expired", "not_found", "forbidden"].includes(reason)
);

const isCancelRejectionReason = (reason) => (
  ["not_cancellable", "not_found", "forbidden"].includes(reason)
);

const createRetryTimestamp = (retryAfterMs, now = Date.now()) => {
  const retryAtSeconds = Math.ceil((now + Math.max(0, Number(retryAfterMs) || 0)) / 1000);
  return `<t:${retryAtSeconds}:t>`;
};

const createImageGenerationDiscordHandler = ({
  service,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  confirmationTtlMs = 180000,
} = {}) => {
  if (!service) throw new Error("service is required");
  const confirmationTimers = new Map();
  const originalMessages = new Map();
  const terminalRequestIds = new Set();

  const handleMessage = async (message) => {
    if (!message || !message.author || message.author.bot) return { handled: false };

    const result = await service.prepareNaturalLanguageCandidate({
      text: message.content || "",
      messageId: message.id,
      guildId: message.guild && message.guild.id,
      channelId: message.channel && message.channel.id ? message.channel.id : message.channelId,
      userId: message.author.id,
      requestedByLabel: getUserLabel(message.author),
    });

    if (!result || result.action === "noop") return { handled: false, result };
    if (result.action !== "confirm") {
      await message.reply({ content: mapErrorMessage(result.errorCategory || result.reason || "unknown") });
      return { handled: true, result };
    }

    const confirmationMessage = await message.reply({
      content: MESSAGES.imageGeneration.confirmation({
        purpose: result.purpose,
        summary: result.summary,
      }),
      components: createConfirmationComponents(result.requestId),
    });

    if (service.recordConfirmationMessage) {
      service.recordConfirmationMessage({
        requestId: result.requestId,
        confirmationMessageId: confirmationMessage && confirmationMessage.id,
      });
    }
    terminalRequestIds.delete(result.requestId);
    originalMessages.set(result.requestId, message);
    scheduleConfirmationExpiry(result.requestId, confirmationMessage);

    return {
      handled: true,
      result,
      confirmationMessage,
    };
  };

  const handleInteraction = async (interaction) => {
    if (!interaction) return { handled: false };
    if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === "image") {
      return handleSlashCommand(interaction);
    }
    if (interaction.isButton && interaction.isButton()) {
      const parsed = parseImageButtonCustomId(interaction.customId);
      if (!parsed) return { handled: false };
      if (parsed.action === CONFIRM_BUTTON_ACTION) {
        return handleConfirmButton(interaction, parsed.requestId);
      }
      return handleCancelButton(interaction, parsed.requestId);
    }
    return { handled: false };
  };

  const handleSlashCommand = async (interaction) => {
    if (interaction.deferReply && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    const prompt = interaction.options.getString("prompt", true);
    const purpose = interaction.options.getString("purpose", false) || "other";
    const abstractModel = interaction.options.getString("model", false) || "standard";
    const result = await service.runSlashCommand({
      prompt,
      purpose,
      abstractModel,
      messageId: interaction.id,
      guildId: interaction.guildId || (interaction.guild && interaction.guild.id),
      channelId: interaction.channelId || (interaction.channel && interaction.channel.id),
      userId: interaction.user && interaction.user.id,
      requestedByLabel: getUserLabel(interaction.user),
    });

    await deliverResult({
      result,
      statusMessage: interaction,
      imageTarget: interaction,
      requestId: result && result.requestId,
      queuedMessageUpdater: interaction,
    });
    return { handled: true, result };
  };

  const handleConfirmButton = async (interaction, requestId) => {
    let ackUpdatedMessage = false;
    if (interaction.deferUpdate) {
      await interaction.deferUpdate();
    } else if (interaction.update) {
      await interaction.update({
        content: MESSAGES.imageGeneration.accepted,
        components: [],
      });
      ackUpdatedMessage = true;
    }

    const result = await service.confirm({
      requestId,
      userId: interaction.user && interaction.user.id,
    });

    if (result && result.action === "rejected" && isConfirmRejectionReason(result.reason)) {
      await replyEphemeral(interaction, mapErrorMessage(result.reason));
      return { handled: true, result };
    }

    clearConfirmationTimer(requestId);
    if (!ackUpdatedMessage) {
      await editStatus(interaction.message, {
        content: MESSAGES.imageGeneration.accepted,
        components: [],
      });
    }

    await deliverResult({
      result,
      statusMessage: interaction.message,
      imageTarget: originalMessages.get(requestId) || interaction.message || interaction,
      requestId,
      queuedMessageUpdater: interaction.message,
    });
    return { handled: true, result };
  };

  const handleCancelButton = async (interaction, requestId) => {
    const result = service.cancel({
      requestId,
      userId: interaction.user && interaction.user.id,
    });

    if (result && result.action === "rejected" && isCancelRejectionReason(result.reason)) {
      await replyEphemeral(interaction, mapErrorMessage(result.reason));
      return { handled: true, result };
    }

    cleanupTerminal(requestId, { terminal: true });
    if (interaction.update) {
      await interaction.update({
        content: MESSAGES.imageGeneration.cancelled,
        components: [],
      });
    }
    return { handled: true, result };
  };

  const deliverResult = async ({ result, statusMessage, imageTarget, requestId, queuedMessageUpdater }) => {
    if (!result) return;
    if (result.action === "running") {
      await editStatus(statusMessage, {
        content: MESSAGES.imageGeneration.accepted,
        components: [],
      });
      monitorCompletion({
        completionPromise: result.completionPromise,
        statusMessage: queuedMessageUpdater || statusMessage,
        imageTarget,
        requestId: result.requestId || requestId,
      });
      return;
    }
    if (result.action === "queued") {
      await editStatus(statusMessage, {
        content: MESSAGES.imageGeneration.queued(result.position || 1),
        components: createQueueComponents(result.requestId || requestId),
      });
      monitorCompletion({
        completionPromise: result.completionPromise,
        statusMessage: queuedMessageUpdater || statusMessage,
        imageTarget,
        requestId: result.requestId || requestId,
      });
      return;
    }
    if (result.action === "completed") {
      await sendCompletedImage({ result, statusMessage, imageTarget, requestId: result.requestId || requestId });
      return;
    }
    if (result.action === "rate_limited") {
      await editStatus(statusMessage, {
        content: MESSAGES.imageGeneration.rateLimited(createRetryTimestamp(result.retryAfterMs)),
        components: [],
      });
      cleanupTerminal(result.requestId || requestId);
      return;
    }
    if (result.action === "rejected" || result.action === "failed" || result.action === "cancelled") {
      const category = result.errorCategory || result.reason || "unknown";
      await editStatus(statusMessage, {
        content: result.action === "cancelled"
          ? MESSAGES.imageGeneration.cancelled
          : mapErrorMessage(category),
        components: [],
      });
      cleanupTerminal(result.requestId || requestId, { terminal: result.action === "cancelled" });
    }
  };

  const monitorCompletion = ({ completionPromise, statusMessage, imageTarget, requestId }) => {
    if (!completionPromise || typeof completionPromise.then !== "function") return;
    completionPromise
      .then((completion) => {
        const completionRequestId = completion && completion.requestId ? completion.requestId : requestId;
        if (terminalRequestIds.has(completionRequestId)) return null;
        return deliverResult({
          result: completion,
          statusMessage,
          imageTarget: originalMessages.get(completionRequestId) || imageTarget,
          requestId: completionRequestId,
        });
      })
      .catch((error) => {
        logger.warn({ err: error }, "[image-generation] queued completion failed");
        cleanupTerminal(requestId);
        return editStatus(statusMessage, {
          content: mapErrorMessage("unknown"),
          components: [],
        });
      });
  };

  const sendCompletedImage = async ({ result, statusMessage, imageTarget, requestId }) => {
    if (!result || result.action !== "completed" || !result.image || !result.image.base64) {
      const category = result && (result.errorCategory || result.reason) ? result.errorCategory || result.reason : "unknown";
      await editStatus(statusMessage, { content: mapErrorMessage(category), components: [] });
      cleanupTerminal(requestId);
      return;
    }
    const attachment = createImageAttachment(result.image, requestId);
    if (
      imageTarget &&
      typeof imageTarget.editReply === "function" &&
      (imageTarget.deferred || imageTarget.replied)
    ) {
      await imageTarget.editReply({
        content: "",
        files: [attachment],
        components: [],
      });
      cleanupTerminal(requestId);
      return;
    } else if (imageTarget && typeof imageTarget.reply === "function") {
      await imageTarget.reply({
        content: "",
        files: [attachment],
      });
    } else if (imageTarget && typeof imageTarget.followUp === "function") {
      await imageTarget.followUp({
        content: "",
        files: [attachment],
      });
    }
    cleanupTerminal(requestId);
    await editStatus(statusMessage, {
      content: MESSAGES.imageGeneration.completed,
      components: [],
    });
  };

  const editStatus = async (target, payload) => {
    if (!target) return null;
    if (typeof target.edit === "function") return target.edit(payload);
    if (typeof target.editReply === "function") return target.editReply(payload);
    if (typeof target.update === "function") return target.update(payload);
    return null;
  };

  const scheduleConfirmationExpiry = (requestId, confirmationMessage) => {
    clearConfirmationTimer(requestId);
    const timer = setTimeoutFn(async () => {
      try {
        if (service.expireConfirmation) service.expireConfirmation({ requestId });
        await safeEdit(confirmationMessage, {
          content: MESSAGES.imageGeneration.expired,
          components: createConfirmationComponents(requestId, { disabled: true }),
        });
      } catch (error) {
        logger.warn({ err: error, requestId }, "[image-generation] confirmation expiry failed");
      } finally {
        cleanupTerminal(requestId, { terminal: true });
        confirmationTimers.delete(requestId);
      }
    }, confirmationTtlMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    confirmationTimers.set(requestId, timer);
  };

  const clearConfirmationTimer = (requestId) => {
    const timer = confirmationTimers.get(requestId);
    if (timer) clearTimeoutFn(timer);
    confirmationTimers.delete(requestId);
  };

  const cleanupTerminal = (requestId, { terminal = false } = {}) => {
    if (!requestId) return;
    if (terminal) terminalRequestIds.add(requestId);
    originalMessages.delete(requestId);
    clearConfirmationTimer(requestId);
  };

  return {
    handleMessage,
    handleInteraction,
    handleSlashCommand,
    handleConfirmButton,
    handleCancelButton,
    parseImageButtonCustomId,
  };
};

module.exports = {
  IMAGE_BUTTON_PREFIX,
  CONFIRM_BUTTON_ACTION,
  CANCEL_BUTTON_ACTION,
  createButtonCustomId,
  parseImageButtonCustomId,
  createImageGenerationDiscordHandler,
};
