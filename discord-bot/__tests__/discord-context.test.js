const {
  collectRecentChannelContextEntries,
  resolveDiscordContextLimits,
} = require("../src/discord-context");

const makeMessage = ({
  id,
  channel,
  authorId = "user_1",
  authorBot = false,
  content = "message",
  timestamp = 0,
  referenceMessageId = "",
}) => ({
  id,
  channel,
  channelId: channel.id,
  author: {
    id: authorId,
    bot: authorBot,
    username: authorBot ? "fairy" : "user",
  },
  content,
  createdTimestamp: timestamp,
  createdAt: new Date(timestamp),
  reference: referenceMessageId ? { messageId: referenceMessageId } : null,
});

const makeCollection = (messages) => new Map(messages.map((message) => [message.id, message]));

const makeChannel = ({ id = "channel_1", thread = false, batches = [] } = {}) => {
  const fetch = jest.fn(async (request) => {
    if (request && request.around) {
      return makeCollection(batches.around || []);
    }
    const index = fetch.mock.calls.filter(([arg]) => !arg.around).length - 1;
    return makeCollection(batches.recent && batches.recent[index] ? batches.recent[index] : []);
  });
  return {
    id,
    isThread: () => thread,
    messages: { fetch },
  };
};

describe("discord context collector", () => {
  it("collects a wider recent context and keeps bot messages with metadata", async () => {
    const channel = makeChannel();
    channel.messages.fetch.mockImplementation(async () =>
      makeCollection([
        makeMessage({ id: "m3", channel, authorId: "bot_1", authorBot: true, content: "bot reply", timestamp: 3000 }),
        makeMessage({ id: "m2", channel, content: "second", timestamp: 2000 }),
        makeMessage({ id: "m1", channel, content: "first", timestamp: 1000 }),
      ])
    );

    const result = await collectRecentChannelContextEntries(
      { channel, content: "", guildId: "guild_1" },
      { limits: { maxMessages: 10, maxChars: 1000, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 5, maxTargetMessages: 3 } }
    );

    expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 10, cache: false });
    expect(result.entries.map((entry) => entry.message_id)).toEqual(["m1", "m2", "m3"]);
    expect(result.entries[2]).toMatchObject({
      author_id: "bot_1",
      author_is_bot: true,
      context_source: "recent",
      content: "bot reply",
    });
    expect(result.meta).toMatchObject({
      scope: "channel",
      used_messages: 3,
      included_bot_messages: 1,
      truncated: false,
    });
  });

  it("fetches context around Discord message URLs", async () => {
    const currentChannel = makeChannel({ id: "1501907581835153510", thread: true, batches: { recent: [[]] } });
    const linkedChannel = makeChannel({ id: "1465296404455882860" });
    const targetMessage = makeMessage({ id: "1503204921187635221", channel: linkedChannel, content: "linked context", timestamp: 5000 });
    linkedChannel.messages.fetch.mockResolvedValue(makeCollection([targetMessage]));
    const client = { channels: { fetch: jest.fn(async () => linkedChannel) } };

    const result = await collectRecentChannelContextEntries(
      {
        channel: currentChannel,
        channelId: "1501907581835153510",
        guildId: "840827137451229205",
        client,
        operationChannelId: "1465296404455882860",
        content: "これ見て https://discord.com/channels/840827137451229205/1465296404455882860/1503204921187635221",
      },
      { limits: { maxMessages: 10, maxChars: 1000, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 7, maxTargetMessages: 3 } }
    );

    expect(client.channels.fetch).toHaveBeenCalledWith("1465296404455882860");
    expect(linkedChannel.messages.fetch).toHaveBeenCalledWith({ around: "1503204921187635221", limit: 7, cache: false });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      message_id: "1503204921187635221",
      channel_id: "1465296404455882860",
      content: "linked context",
    });
    expect(result.entries[0].context_source).toContain("discord_url");
    expect(result.entries[0].context_source).toContain("discord_url_target");
    expect(result.meta).toMatchObject({ scope: "thread", target_fetches: 1, target_message_count: 1 });
  });

  it("does not fetch Discord URL context from unapproved channels", async () => {
    const currentChannel = makeChannel({ id: "1501907581835153510", thread: true, batches: { recent: [[]] } });
    const linkedChannel = makeChannel({ id: "999999999999999999" });
    const client = { channels: { fetch: jest.fn(async () => linkedChannel) } };

    const result = await collectRecentChannelContextEntries(
      {
        channel: currentChannel,
        channelId: "1501907581835153510",
        guildId: "840827137451229205",
        client,
        operationChannelId: "1465296404455882860",
        allowedChannelIds: new Set(["1465296404455882860"]),
        content: "これは読まない https://discord.com/channels/840827137451229205/999999999999999999/1503204921187635221",
      },
      { limits: { maxMessages: 10, maxChars: 1000, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 7, maxTargetMessages: 3 } }
    );

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.meta.target_fetches).toBe(0);
    expect(result.meta.target_fetch_failures).toBe(1);
    expect(result.meta.target_message_count).toBe(1);
  });

  it("keeps explicit target context when recent fetch fails", async () => {
    const currentChannel = makeChannel({ id: "1501907581835153510", thread: true });
    currentChannel.messages.fetch.mockRejectedValue(new Error("recent failed"));
    const targetMessage = makeMessage({ id: "1503204921187635221", channel: currentChannel, content: "reply context", timestamp: 5000 });
    currentChannel.messages.fetch.mockImplementation(async (request) => {
      if (request.around) return makeCollection([targetMessage]);
      throw new Error("recent failed");
    });

    const result = await collectRecentChannelContextEntries(
      {
        channel: currentChannel,
        channelId: "1501907581835153510",
        guildId: "840827137451229205",
        reference: { messageId: "1503204921187635221" },
        content: "返信です",
      },
      { limits: { maxMessages: 10, maxChars: 1000, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 7, maxTargetMessages: 3 } }
    );

    expect(result.entries.map((entry) => entry.message_id)).toEqual(["1503204921187635221"]);
    expect(result.entries[0].context_source).toContain("reply_reference_target");
    expect(result.meta.reason).toBe("partial_fetch_failed");
  });

  it("prioritizes the explicitly linked target message before nearby context", async () => {
    const currentChannel = makeChannel({ id: "1501907581835153510", thread: true, batches: { recent: [[]] } });
    const linkedChannel = makeChannel({ id: "1465296404455882860" });
    linkedChannel.messages.fetch.mockResolvedValue(makeCollection([
      makeMessage({ id: "older_1", channel: linkedChannel, content: "older nearby", timestamp: 1000 }),
      makeMessage({ id: "older_2", channel: linkedChannel, content: "second nearby", timestamp: 2000 }),
      makeMessage({ id: "1503204921187635221", channel: linkedChannel, content: "target body", timestamp: 3000 }),
    ]));
    const client = { channels: { fetch: jest.fn(async () => linkedChannel) } };

    const result = await collectRecentChannelContextEntries(
      {
        channel: currentChannel,
        channelId: "1501907581835153510",
        guildId: "840827137451229205",
        client,
        operationChannelId: "1465296404455882860",
        content: "これ見て https://discord.com/channels/840827137451229205/1465296404455882860/1503204921187635221",
      },
      { limits: { maxMessages: 2, maxChars: 1000, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 7, maxTargetMessages: 3 } }
    );

    expect(result.entries.map((entry) => entry.message_id)).toContain("1503204921187635221");
    expect(result.entries.find((entry) => entry.message_id === "1503204921187635221").context_source).toContain("discord_url_target");
  });

  it("honors char budget while keeping the newest messages", async () => {
    const channel = makeChannel({ id: "channel_1" });
    channel.messages.fetch.mockResolvedValue(makeCollection([
      makeMessage({ id: "m1", channel, content: "older text", timestamp: 1000 }),
      makeMessage({ id: "m2", channel, content: "newer text", timestamp: 2000 }),
    ]));

    const result = await collectRecentChannelContextEntries(
      { channel, content: "", guildId: "guild_1" },
      { limits: { maxMessages: 10, maxChars: 10, maxCharsPerMessage: 200, fetchBatchSize: 10, maxBatches: 1, aroundLimit: 5, maxTargetMessages: 3 } }
    );

    expect(result.entries.map((entry) => entry.message_id)).toEqual(["m2"]);
    expect(result.meta.truncated).toBe(true);
  });

  it("resolves environment limits with bounded defaults", () => {
    expect(resolveDiscordContextLimits({
      FAIRY_CONTEXT_MAX_MESSAGES: "500",
      FAIRY_CONTEXT_MAX_CHARS: "10",
      FAIRY_CONTEXT_AROUND_LIMIT: "500",
    })).toMatchObject({
      maxMessages: 100,
      maxChars: 1000,
      aroundLimit: 100,
    });
  });
});
