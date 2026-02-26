"use strict";

const REQUIRED_FIRST_REPLY_EXPORTS = [
  "buildFallbackFirstReplyMessage",
  "normalizeFirstReplyForDiscord",
  "createOpenAiFirstReplyComposer",
];

const REQUIRED_SLOW_PATH_EXPORTS = [
  "SLOW_PATH_TRIGGER_SOURCES",
  "assertSlowPathJobPayloadContract",
];

const defaultRequireImpl = (moduleName) => require(moduleName);

const ensureFunctionExport = (module, name, moduleName) => {
  if (!module || typeof module[name] !== "function") {
    throw new Error(`invalid fairy-core export: ${moduleName}.${name}`);
  }
};

const createFairyCoreAdapter = ({ requireImpl = defaultRequireImpl } = {}) => {
  const firstReplyModule = requireImpl("@fff-sissimo/fairy-core/first-reply");
  for (const name of REQUIRED_FIRST_REPLY_EXPORTS) {
    ensureFunctionExport(firstReplyModule, name, "@fff-sissimo/fairy-core/first-reply");
  }

  const slowPathModule = requireImpl("@fff-sissimo/fairy-core/slow-path-payload");
  if (!Array.isArray(slowPathModule && slowPathModule.SLOW_PATH_TRIGGER_SOURCES)) {
    throw new Error("invalid fairy-core export: @fff-sissimo/fairy-core/slow-path-payload.SLOW_PATH_TRIGGER_SOURCES");
  }
  ensureFunctionExport(
    slowPathModule,
    "assertSlowPathJobPayloadContract",
    "@fff-sissimo/fairy-core/slow-path-payload"
  );

  return {
    buildFallbackFirstReplyMessage: firstReplyModule.buildFallbackFirstReplyMessage,
    normalizeFirstReplyForDiscord: firstReplyModule.normalizeFirstReplyForDiscord,
    createOpenAiFirstReplyComposer: firstReplyModule.createOpenAiFirstReplyComposer,
    SLOW_PATH_TRIGGER_SOURCES: Object.freeze([...slowPathModule.SLOW_PATH_TRIGGER_SOURCES]),
    assertSlowPathJobPayloadContract: slowPathModule.assertSlowPathJobPayloadContract,
    source: {
      firstReply: "package",
      slowPath: "package",
    },
  };
};

const fairyCoreAdapter = createFairyCoreAdapter();

module.exports = {
  createFairyCoreAdapter,
  fairyCoreAdapter,
};
