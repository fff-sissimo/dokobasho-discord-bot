const { createFairyCoreAdapter } = require("../src/fairy-core-adapter");

describe("fairy-core adapter", () => {
  it("package が利用可能な場合は package 実装を使う", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (moduleName === "@fff-sissimo/fairy-core/first-reply") {
          return {
            buildFallbackFirstReplyMessage: () => "package-first-reply",
            normalizeFirstReplyForDiscord: () => "package-normalized",
            createOpenAiFirstReplyComposer: () => "package-composer",
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

    expect(adapter.source.firstReply).toBe("package");
    expect(adapter.source.slowPath).toBe("package");
    expect(adapter.buildFallbackFirstReplyMessage("x")).toBe("package-first-reply");
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
          if (moduleName === "@fff-sissimo/fairy-core/first-reply") {
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

  it("real fairy-core package が導入済みなら export 契約を満たす", () => {
    const adapter = createFairyCoreAdapter({
      requireImpl: (moduleName) => {
        if (
          moduleName === "@fff-sissimo/fairy-core/first-reply" ||
          moduleName === "@fff-sissimo/fairy-core/slow-path-payload"
        ) {
          return require(moduleName);
        }
        throw new Error(`unexpected module: ${moduleName}`);
      },
    });

    expect(adapter.source.firstReply).toBe("package");
    expect(adapter.source.slowPath).toBe("package");
    expect(typeof adapter.buildFallbackFirstReplyMessage).toBe("function");
    expect(typeof adapter.normalizeFirstReplyForDiscord).toBe("function");
    expect(typeof adapter.createOpenAiFirstReplyComposer).toBe("function");
    expect(Array.isArray(adapter.SLOW_PATH_TRIGGER_SOURCES)).toBe(true);
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
  });
});
