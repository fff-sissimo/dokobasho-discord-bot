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
  if (message.author.bot) return;
  if (!client.user) return;
  const isDirectMention = message.mentions.users.has(client.user.id);
  let isReplyToBot = message.mentions.repliedUser?.id === client.user.id;
  if (!isReplyToBot && message.reference?.messageId) {
    try {
      const referencedMessage = await message.fetchReference();
      isReplyToBot = referencedMessage.author?.id === client.user.id;
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
