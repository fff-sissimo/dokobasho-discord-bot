const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Client, GatewayIntentBits, Events } = require("discord.js");

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing ${name}`);
    process.exit(1);
  }
  return value;
};

const token = requireEnv("DISCORD_BOT_TOKEN");
const webhookUrl = requireEnv("N8N_WEBHOOK_URL");

// In-memory cache of recent bot message IDs for reply detection.
const BOT_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BOT_MESSAGE_CACHE_MAX = 1000;
const botMessageCache = new Map();

const pruneBotMessageCache = (now) => {
  for (const [messageId, timestamp] of botMessageCache) {
    if (now - timestamp > BOT_MESSAGE_CACHE_TTL_MS) {
      botMessageCache.delete(messageId);
    }
  }
  if (botMessageCache.size <= BOT_MESSAGE_CACHE_MAX) return;
  const entries = Array.from(botMessageCache.entries());
  entries.sort((a, b) => a[1] - b[1]);
  const excess = entries.length - BOT_MESSAGE_CACHE_MAX;
  for (let i = 0; i < excess; i += 1) {
    botMessageCache.delete(entries[i][0]);
  }
};

const rememberBotMessage = (messageId) => {
  const now = Date.now();
  botMessageCache.set(messageId, now);
  pruneBotMessageCache(now);
};

const isRecentBotMessage = (messageId) => {
  const timestamp = botMessageCache.get(messageId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > BOT_MESSAGE_CACHE_TTL_MS) {
    botMessageCache.delete(messageId);
    return false;
  }
  return true;
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const buildPayload = (message) => ({
  discord_user_id: message.author.id,
  discord_username: message.author.username,
  channel_id: message.channel?.id ?? null,
  guild_id: message.guild?.id ?? null,
  message_id: message.id,
  content: message.content,
  created_at: message.createdAt.toISOString(),
});

client.once(Events.ClientReady, (c) => {
  console.log(`[clientReady] Logged in as ${c.user.tag}`);
});

client.on("messageCreate", async (message) => {
  console.log(
    `[message] id=${message.id} author=${message.author.tag} bot=${message.author.bot} content=${JSON.stringify(
      message.content
    )}`
  );
  if (!client.user) return;
  if (message.author.bot) {
    if (message.author.id === client.user.id) {
      rememberBotMessage(message.id);
    }
    return;
  }
  const isDirectMention = message.mentions.users.has(client.user.id);
  let isReplyToBot = message.mentions.repliedUser?.id === client.user.id;
  const referenceId = message.reference?.messageId;
  if (!isReplyToBot && referenceId) {
    if (isRecentBotMessage(referenceId)) {
      isReplyToBot = true;
    }
  }
  if (!isReplyToBot && referenceId) {
    try {
      const referencedMessage = await message.fetchReference();
      isReplyToBot = referencedMessage.author?.id === client.user.id;
      if (isReplyToBot) {
        rememberBotMessage(referencedMessage.id);
      }
    } catch (error) {
      console.warn("[reply] Failed to fetch referenced message", error);
    }
  }
  if (!isDirectMention && !isReplyToBot) return;

  const payload = buildPayload(message);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(`[webhook] Non-2xx response: ${response.status}`);
    }
  } catch (error) {
    console.error("[webhook] Request failed", error);
  }
});

client.login(token).catch((error) => {
  console.error("[login] Failed to login", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});
