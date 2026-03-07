jest.mock("../src/logger", () => ({
  warn: jest.fn(),
}));

const { resolveReplyAntecedentEntry } = require("../src/reply-antecedent");
const logger = require("../src/logger");

describe("reply antecedent resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns structured antecedent entry when reference fetch succeeds", async () => {
    const entry = await resolveReplyAntecedentEntry({
      reference: { messageId: "anchor_001" },
      fetchReference: jest.fn().mockResolvedValue({
        id: "anchor_001",
        author: { id: "user_001", bot: false },
        content: "  元メッセージ\nです  ",
      }),
    });

    expect(entry).toEqual({
      message_id: "anchor_001",
      author_user_id: "user_001",
      author_is_bot: false,
      content: "元メッセージ です",
    });
  });

  it("returns undefined when message has no reply reference", async () => {
    await expect(resolveReplyAntecedentEntry({ reference: null })).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns undefined and logs when fetchReference is unavailable", async () => {
    await expect(
      resolveReplyAntecedentEntry({
        reference: { messageId: "anchor_missing_fetch" },
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      { referenceId: "anchor_missing_fetch" },
      "[fairy] reply antecedent fetchReference unavailable"
    );
  });

  it("returns undefined when fetchReference throws", async () => {
    await expect(
      resolveReplyAntecedentEntry({
        reference: { messageId: "anchor_002" },
        fetchReference: jest.fn().mockRejectedValue(new Error("missing")),
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: "anchor_002", err: expect.any(Error) }),
      "[fairy] reply antecedent resolution failed"
    );
  });

  it("returns undefined when referenced author is missing", async () => {
    await expect(
      resolveReplyAntecedentEntry({
        reference: { messageId: "anchor_003" },
        fetchReference: jest.fn().mockResolvedValue({
          id: "anchor_003",
          author: null,
          content: "本文",
        }),
      })
    ).resolves.toBeUndefined();
  });

  it("returns undefined when normalized content is empty because v3 antecedent requires text", async () => {
    await expect(
      resolveReplyAntecedentEntry({
        reference: { messageId: "anchor_004" },
        fetchReference: jest.fn().mockResolvedValue({
          id: "anchor_004",
          author: { id: "user_004", bot: true },
          content: "   ",
        }),
      })
    ).resolves.toBeUndefined();
  });

  it("preserves bot authored flag when antecedent is valid", async () => {
    const entry = await resolveReplyAntecedentEntry({
      reference: { messageId: "anchor_005" },
      fetchReference: jest.fn().mockResolvedValue({
        id: "anchor_005",
        author: { id: "bot_005", bot: true },
        content: "bot summary",
      }),
    });

    expect(entry).toEqual({
      message_id: "anchor_005",
      author_user_id: "bot_005",
      author_is_bot: true,
      content: "bot summary",
    });
  });

  it("truncates very long antecedent content safely", async () => {
    const entry = await resolveReplyAntecedentEntry({
      reference: { messageId: "anchor_006" },
      fetchReference: jest.fn().mockResolvedValue({
        id: "anchor_006",
        author: { id: "user_006", bot: false },
        content: `${"🙂".repeat(6100)} 終端`,
      }),
    });

    expect(entry.message_id).toBe("anchor_006");
    expect(Array.from(entry.content)).toHaveLength(6000);
    expect(entry.content.endsWith("終端")).toBe(false);
  });
});
