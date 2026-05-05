const { createFairyCoreAdapter } = require("../src/fairy-core-adapter");

describe("fairy-core adapter", () => {
  it("first-reply / slow-path は local 実装を使う", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (moduleName === "./fairy-first-reply-ai") {
          return {
            buildFallbackFirstReplyMessage: () => "local-first-reply",
            normalizeFirstReplyForDiscord: () => "local-normalized",
            createOpenAiFirstReplyComposer: () => "local-composer",
          };
        }
        if (moduleName === "./slow-path-payload-contract") {
          return {
            SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
            SLOW_PATH_PAYLOAD_SCHEMA_VERSION: "3",
            assertSlowPathJobPayloadContract: () => {},
          };
        }
        throw new Error(`unexpected module: ${moduleName}`);
      },
    });

    expect(adapter.source.firstReply).toBe("local");
    expect(adapter.source.slowPath).toBe("local");
    expect(adapter.buildFallbackFirstReplyMessage("x")).toBe("local-first-reply");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
    expect(() => adapter.assertSlowPathJobPayloadContract()).not.toThrow();
    expect(adapter.SLOW_PATH_PAYLOAD_SCHEMA_VERSION).toBe("3");
  });

  it("local module が使えない場合は初期化エラーにする", () => {
    expect(() =>
      createFairyCoreAdapter({
        requireImpl: () => {
          throw new Error("module not found");
        },
      })
    ).toThrow("module not found");
  });

  it("package export が不足している場合は初期化エラーにする", () => {
    expect(() =>
      createFairyCoreAdapter({
        requireImpl: (moduleName) => {
        if (moduleName === "./fairy-first-reply-ai") {
            return {
              buildFallbackFirstReplyMessage: () => "ok",
            };
          }
        if (moduleName === "./slow-path-payload-contract") {
            return {
              SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
              SLOW_PATH_PAYLOAD_SCHEMA_VERSION: "3",
              assertSlowPathJobPayloadContract: () => {},
            };
          }
          throw new Error(`unexpected module: ${moduleName}`);
        },
      })
    ).toThrow("invalid fairy-core export");
  });

  it("schema version export が欠けている場合は初期化エラーにする", () => {
    expect(() =>
      createFairyCoreAdapter({
        requireImpl: (moduleName) => {
        if (moduleName === "./fairy-first-reply-ai") {
            return {
              buildFallbackFirstReplyMessage: () => "ok",
              normalizeFirstReplyForDiscord: () => "ok",
              createOpenAiFirstReplyComposer: () => "ok",
            };
          }
        if (moduleName === "./slow-path-payload-contract") {
            return {
              SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
              assertSlowPathJobPayloadContract: () => {},
            };
          }
          throw new Error(`unexpected module: ${moduleName}`);
        },
      })
    ).toThrow("SLOW_PATH_PAYLOAD_SCHEMA_VERSION");
  });

  it("real local modules が export 契約を満たす", () => {
    const adapter = createFairyCoreAdapter();

    expect(adapter.source.firstReply).toBe("local");
    expect(adapter.source.slowPath).toBe("local");
    expect(typeof adapter.buildFallbackFirstReplyMessage).toBe("function");
    expect(typeof adapter.normalizeFirstReplyForDiscord).toBe("function");
    expect(typeof adapter.createOpenAiFirstReplyComposer).toBe("function");
    expect(Array.isArray(adapter.SLOW_PATH_TRIGGER_SOURCES)).toBe(true);
    expect(typeof adapter.SLOW_PATH_PAYLOAD_SCHEMA_VERSION).toBe("string");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
  });
});
