const { createFairyCoreAdapter } = require("../src/fairy-core-adapter");

const hasRealFairyCoreModules = (() => {
  try {
    require.resolve("@fff-sissimo/fairy-core/first-reply");
    require.resolve("@fff-sissimo/fairy-core/slow-path-payload");
    return true;
  } catch (_error) {
    return false;
  }
})();

describe("fairy-core adapter", () => {
  it("first-reply / slow-path は package 実装を使う", () => {
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
            SLOW_PATH_PAYLOAD_SCHEMA_VERSION: "3",
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
    expect(adapter.SLOW_PATH_PAYLOAD_SCHEMA_VERSION).toBe("3");
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
          if (moduleName === "@fff-sissimo/fairy-core/first-reply") {
            return {
              buildFallbackFirstReplyMessage: () => "ok",
              normalizeFirstReplyForDiscord: () => "ok",
              createOpenAiFirstReplyComposer: () => "ok",
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
    ).toThrow("SLOW_PATH_PAYLOAD_SCHEMA_VERSION");
  });

  (hasRealFairyCoreModules ? it : it.skip)("real modules が導入済みなら export 契約を満たす", () => {
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
    expect(typeof adapter.SLOW_PATH_PAYLOAD_SCHEMA_VERSION).toBe("string");
    expect(typeof adapter.assertSlowPathJobPayloadContract).toBe("function");
  });
});
