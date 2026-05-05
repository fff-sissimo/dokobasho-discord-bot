"use strict";

const REQUIRED_FIRST_REPLY_EXPORTS = [
  "buildFallbackFirstReplyMessage",
  "normalizeFirstReplyForDiscord",
  "createOpenAiFirstReplyComposer",
];

const defaultRequireImpl = (moduleName) => require(moduleName);

const ensureFunctionExport = (module, name, moduleName) => {
  if (!module || typeof module[name] !== "function") {
    throw new Error(`invalid fairy-core export: ${moduleName}.${name}`);
  }
};

const createFairyCoreAdapter = ({ requireImpl = defaultRequireImpl } = {}) => {
  const firstReplyModule = requireImpl("./fairy-first-reply-ai");
  for (const name of REQUIRED_FIRST_REPLY_EXPORTS) {
    ensureFunctionExport(firstReplyModule, name, "./fairy-first-reply-ai");
  }

  const slowPathModule = requireImpl("./slow-path-payload-contract");
  if (!Array.isArray(slowPathModule && slowPathModule.SLOW_PATH_TRIGGER_SOURCES)) {
    throw new Error("invalid fairy-core export: ./slow-path-payload-contract.SLOW_PATH_TRIGGER_SOURCES");
  }
  const schemaVersion =
    slowPathModule &&
    typeof slowPathModule.SLOW_PATH_PAYLOAD_SCHEMA_VERSION === "string" &&
    slowPathModule.SLOW_PATH_PAYLOAD_SCHEMA_VERSION.length > 0
      ? slowPathModule.SLOW_PATH_PAYLOAD_SCHEMA_VERSION
      : null;
  if (!schemaVersion) {
    throw new Error("invalid fairy-core export: ./slow-path-payload-contract.SLOW_PATH_PAYLOAD_SCHEMA_VERSION");
  }
  ensureFunctionExport(
    slowPathModule,
    "assertSlowPathJobPayloadContract",
    "./slow-path-payload-contract"
  );

  return {
    buildFallbackFirstReplyMessage: firstReplyModule.buildFallbackFirstReplyMessage,
    normalizeFirstReplyForDiscord: firstReplyModule.normalizeFirstReplyForDiscord,
    createOpenAiFirstReplyComposer: firstReplyModule.createOpenAiFirstReplyComposer,
    SLOW_PATH_TRIGGER_SOURCES: Object.freeze([...slowPathModule.SLOW_PATH_TRIGGER_SOURCES]),
    SLOW_PATH_PAYLOAD_SCHEMA_VERSION: schemaVersion,
    assertSlowPathJobPayloadContract: slowPathModule.assertSlowPathJobPayloadContract,
    source: {
      firstReply: "local",
      slowPath: "local",
    },
  };
};

const fairyCoreAdapter = createFairyCoreAdapter();

module.exports = {
  createFairyCoreAdapter,
  fairyCoreAdapter,
};
