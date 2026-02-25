const { createFairyCoreAdapter } = require("../src/fairy-core-adapter");

describe("fairy-core adapter", () => {
  it("package が利用可能な場合は package 実装を使う", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (moduleName === "@fff-sissimo/fairy-core/first-reply") {
          return {
            buildFallbackFirstReplyMessage: () => "package-first-reply",
            normalizeFirstReplyForDiscord: () => "package-normalized",
            createOpenAiFirstReplyComposer: () => "package-composer"
          };
        }
        if (moduleName === "@fff-sissimo/fairy-core/slow-path-payload") {
          return {
            SLOW_PATH_TRIGGER_SOURCES: ["slash_command", "mention", "reply"],
            assertSlowPathJobPayloadContract: () => {}
          };
        }
        throw new Error(`unexpected module: ${moduleName}`);
      }
    });

    expect(adapter.source.firstReply).toBe("package");
    expect(adapter.source.slowPath).toBe("package");
    expect(adapter.buildFallbackFirstReplyMessage("x")).toBe("package-first-reply");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
    expect(() => adapter.assertSlowPathJobPayloadContract()).not.toThrow();
  });

  it("package が使えない場合はローカル実装へフォールバックする", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: () => {
        throw new Error("module not found");
      }
    });

    expect(adapter.source.firstReply).toBe("local-fallback");
    expect(adapter.source.slowPath).toBe("local-fallback");
    expect(typeof adapter.buildFallbackFirstReplyMessage).toBe("function");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
  });

  it("real fairy-core package が導入済みなら export 契約を満たす", () => {
    let firstReplyModule;
    let slowPathModule;
    try {
      firstReplyModule = require("@fff-sissimo/fairy-core/first-reply");
      slowPathModule = require("@fff-sissimo/fairy-core/slow-path-payload");
    } catch (_error) {
      return;
    }

    expect(typeof firstReplyModule.buildFallbackFirstReplyMessage).toBe("function");
    expect(typeof firstReplyModule.normalizeFirstReplyForDiscord).toBe("function");
    expect(typeof firstReplyModule.createOpenAiFirstReplyComposer).toBe("function");
    expect(Array.isArray(slowPathModule.SLOW_PATH_TRIGGER_SOURCES)).toBe(true);
    expect(typeof slowPathModule.assertSlowPathJobPayloadContract).toBe("function");
  });
});
