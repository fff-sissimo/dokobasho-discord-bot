const fs = require("node:fs");
const path = require("node:path");

const packageJsonPath = path.resolve(__dirname, "..", "package.json");
const localSlowPathContractPath = path.resolve(__dirname, "..", "src", "slow-path-payload-contract.js");

describe("fairy-core migration contract", () => {
  it("runtime は private fairy-core package install に依存しない", () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    expect(packageJson.dependencies?.["@fff-sissimo/fairy-core"]).toBeUndefined();
    expect(packageJson.optionalDependencies?.["@fff-sissimo/fairy-core"]).toBeUndefined();
  });

  it("local slow-path contract が schema v3 を正本として提供する", () => {
    expect(fs.existsSync(localSlowPathContractPath)).toBe(true);
    const contract = require(localSlowPathContractPath);
    expect(contract.SLOW_PATH_PAYLOAD_SCHEMA_VERSION).toBe("3");
    expect(contract.SLOW_PATH_TRIGGER_SOURCES).toEqual(["slash_command", "mention", "reply"]);
    expect(typeof contract.assertSlowPathJobPayloadContract).toBe("function");
  });
});
