const { createFairyCoreAdapter } = require("../src/fairy-core-adapter");

describe("fairy-core adapter", () => {
  it("first-reply は local 実装、slow-path は package 実装を使う", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (moduleName === "./fairy-first-reply-ai") {
          return {
            buildFallbackFirstReplyMessage: () => "local-first-reply",
            normalizeFirstReplyForDiscord: () => "local-normalized",
            createOpenAiFirstReplyComposer: () => "local-composer",
          };
        }
        if (moduleName === "@fff-sissimo/fairy-core/slow-path-payload") {
          return {
            SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
            assertSlowPathJobPayloadContract: () => {},
          };
        }
        throw new Error(`unexpected module: ${moduleName}`);
      },
    });

    expect(adapter.source.firstReply).toBe("local");
    expect(adapter.source.slowPath).toBe("package");
    expect(adapter.buildFallbackFirstReplyMessage("x")).toBe("local-first-reply");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
    expect(() => adapter.assertSlowPathJobPayloadContract()).not.toThrow();
  });

  it("package が使えない場合は初期化エラーにする", () => {
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
          if (moduleName === "@fff-sissimo/fairy-core/slow-path-payload") {
            return {
              SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
              assertSlowPathJobPayloadContract: () => {},
            };
          }
          throw new Error(`unexpected module: ${moduleName}`);
        },
      })
    ).toThrow("invalid fairy-core export");
  });

  it("real modules が導入済みなら export 契約を満たす", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (moduleName === "./fairy-first-reply-ai" || moduleName === "@fff-sissimo/fairy-core/slow-path-payload") {
          return moduleName === "./fairy-first-reply-ai"
            ? require("../src/fairy-first-reply-ai")
            : require(moduleName);
        }
        throw new Error(`unexpected module: ${moduleName}`);
      },
    });

    expect(adapter.source.firstReply).toBe("local");
    expect(adapter.source.slowPath).toBe("package");
    expect(typeof adapter.buildFallbackFirstReplyMessage).toBe("function");
    expect(typeof adapter.normalizeFirstReplyForDiscord).toBe("function");
    expect(typeof adapter.createOpenAiFirstReplyComposer).toBe("function");
    expect(Array.isArray(adapter.SLOW_PATH_TRIGGER_SOURCES)).toBe(true);
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
  });
});
